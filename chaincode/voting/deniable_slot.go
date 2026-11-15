package main

// Deniable counted slot (panicPolicy "deniable-slot-v1").
//
// Each nullifier keeps a public "counted slot": an ElGamal vector that is the
// only thing the tally aggregates. On every cast the voter's device submits a
// new slot C' together with a disjunctive Chaum–Pedersen proof that
//
//     C' re-encrypts the visible ballot V          (normal vote)
//  OR C' re-encrypts the previous counted slot C   (panic vote)
//
// without revealing which branch is true. Peers and operators therefore cannot
// tell a panic cast from a normal revote, and a panic cast can never erase the
// voter's earlier normal vote. The first cast uses the trivial encryption of the
// zero vector as the previous slot, so a panic-only voter contributes nothing.
//
// Not covered (see design notes): a coercer who holds the credential and casts
// last himself, forced abstention, and visibility of a later revote event.

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"math/big"
	"strings"
)

const PanicPolicyDeniableSlot = "deniable-slot-v1"

type CountedSlotProof struct {
	Schema string     `json:"schema"`
	C      []string   `json:"c"` // per-branch challenges (2), c[0]+c[1] = H(...)
	Z      [][]string `json:"z"` // per-branch (2), per-candidate responses
}

// CountedSlotStep is one cast in a nullifier's public slot history. Keeping
// every step lets a standalone verifier replay the chain from the zero slot.
// The cast count per nullifier is already public through EvictCount.
type CountedSlotStep struct {
	EncryptedCandidateVector  []ElGamalCiphertext        `json:"encryptedCandidateVector"`
	VectorBallotValidityProof *VectorBallotValidityProof `json:"vectorBallotValidityProof"`
	CountedVector             []ElGamalCiphertext        `json:"countedVector"`
	CountedSlotProof          CountedSlotProof           `json:"countedSlotProof"`
}

type CountedSlotSubmission struct {
	Vector []ElGamalCiphertext `json:"vector"`
	Proof  CountedSlotProof    `json:"proof"`
}

func trivialZeroSlot(n int) []ElGamalCiphertext {
	out := make([]ElGamalCiphertext, n)
	for i := range out {
		out[i] = ElGamalCiphertext{C1: "1", C2: "1"}
	}
	return out
}

func parseSlotElement(hexValue string) (*big.Int, bool) {
	if hexValue == "1" {
		return big.NewInt(1), true
	}
	return parseSubgroupElement(hexValue)
}

func countedSlotChallenge(electionID, nullifierHash string, v, old, next []ElGamalCiphertext, commitments []*big.Int) *big.Int {
	var b strings.Builder
	b.WriteString("mongbas-deniable-slot-v1|")
	b.WriteString(electionID)
	b.WriteString("|")
	b.WriteString(nullifierHash)
	norm := func(h string) string {
		x, ok := new(big.Int).SetString(h, 16)
		if !ok {
			return "invalid"
		}
		return x.Text(16)
	}
	for _, group := range [][]ElGamalCiphertext{v, old, next} {
		for _, ct := range group {
			b.WriteString("|")
			b.WriteString(norm(ct.C1))
			b.WriteString("|")
			b.WriteString(norm(ct.C2))
		}
	}
	for _, t := range commitments {
		b.WriteString("|")
		b.WriteString(t.Text(16))
	}
	sum := sha256.Sum256([]byte(b.String()))
	out := new(big.Int).SetBytes(sum[:])
	return out.Mod(out, elgamalQ)
}

// verifyCountedSlot checks that next re-encrypts either v (branch 0) or old (branch 1).
func verifyCountedSlot(pub *ElGamalPublicKey, electionID, nullifierHash string, v, old, next []ElGamalCiphertext, proof CountedSlotProof) error {
	n := len(v)
	if n == 0 || len(old) != n || len(next) != n {
		return fmt.Errorf("counted slot 길이가 후보 수와 일치하지 않습니다")
	}
	if proof.Schema != PanicPolicyDeniableSlot || len(proof.C) != 2 || len(proof.Z) != 2 || len(proof.Z[0]) != n || len(proof.Z[1]) != n {
		return fmt.Errorf("counted slot proof 형식 오류")
	}
	y, ok := parseSubgroupElement(pub.Y)
	if !ok {
		return fmt.Errorf("선거 공개키 검증 실패")
	}
	parseScalarQ := func(h string) (*big.Int, bool) {
		x, ok := new(big.Int).SetString(h, 16)
		if !ok || x.Sign() < 0 || x.Cmp(elgamalQ) >= 0 {
			return nil, false
		}
		return x, true
	}
	var cs [2]*big.Int
	for j := 0; j < 2; j++ {
		c, ok := parseScalarQ(proof.C[j])
		if !ok {
			return fmt.Errorf("counted slot challenge 형식 오류")
		}
		cs[j] = c
	}
	nextA := make([]*big.Int, n)
	nextB := make([]*big.Int, n)
	for k, ct := range next {
		a, okA := parseSubgroupElement(ct.C1)
		b, okB := parseSubgroupElement(ct.C2)
		if !okA || !okB {
			return fmt.Errorf("counted slot 암호문 군 원소 검증 실패 (index=%d)", k)
		}
		nextA[k], nextB[k] = a, b
	}
	commitments := make([]*big.Int, 0, 4*n)
	for j, base := range [][]ElGamalCiphertext{v, old} {
		for k, ct := range base {
			ba, okA := parseSlotElement(ct.C1)
			bb, okB := parseSlotElement(ct.C2)
			if !okA || !okB {
				return fmt.Errorf("counted slot 기준 암호문 검증 실패 (branch=%d, index=%d)", j, k)
			}
			// D = next / base  ->  (a, b) = (g^s, y^s) for the true branch
			a := new(big.Int).Mul(nextA[k], new(big.Int).ModInverse(ba, elgamalP))
			a.Mod(a, elgamalP)
			b := new(big.Int).Mul(nextB[k], new(big.Int).ModInverse(bb, elgamalP))
			b.Mod(b, elgamalP)
			z, ok := parseScalarQ(proof.Z[j][k])
			if !ok {
				return fmt.Errorf("counted slot response 형식 오류")
			}
			negC := new(big.Int).Sub(elgamalQ, cs[j])
			t1 := new(big.Int).Exp(elgamalG, z, elgamalP)
			t1.Mul(t1, new(big.Int).Exp(a, negC, elgamalP)).Mod(t1, elgamalP)
			t2 := new(big.Int).Exp(y, z, elgamalP)
			t2.Mul(t2, new(big.Int).Exp(b, negC, elgamalP)).Mod(t2, elgamalP)
			commitments = append(commitments, t1, t2)
		}
	}
	expected := countedSlotChallenge(electionID, nullifierHash, v, old, next, commitments)
	sum := new(big.Int).Add(cs[0], cs[1])
	sum.Mod(sum, elgamalQ)
	if sum.Cmp(expected) != 0 {
		return fmt.Errorf("counted slot proof 검증 실패")
	}
	return nil
}

// applyDeniableSlot verifies the submitted slot for a cast and returns the
// extended public slot history and the new counted vector.
func applyDeniableSlot(election *Election, nullifierHash string, visible []ElGamalCiphertext, visibleProof *VectorBallotValidityProof, previous []byte, transient map[string][]byte) ([]ElGamalCiphertext, []CountedSlotStep, error) {
	raw, ok := transient["countedSlot"]
	if !ok || len(raw) == 0 {
		return nil, nil, fmt.Errorf("deniable-slot 선거는 countedSlot transient가 필요합니다")
	}
	var sub CountedSlotSubmission
	if err := json.Unmarshal(raw, &sub); err != nil {
		return nil, nil, fmt.Errorf("countedSlot 파싱 실패: %w", err)
	}
	old := trivialZeroSlot(len(election.Candidates))
	var chain []CountedSlotStep
	if previous != nil {
		var prev Nullifier
		if err := json.Unmarshal(previous, &prev); err != nil {
			return nil, nil, fmt.Errorf("기존 counted slot 파싱 실패: %w", err)
		}
		if len(prev.CountedVector) == len(election.Candidates) {
			old = prev.CountedVector
			chain = append(chain, prev.CountedSlotChain...)
		}
	}
	if err := verifyCountedSlot(election.ElGamalPubKey, election.ElectionID, nullifierHash, visible, old, sub.Vector, sub.Proof); err != nil {
		return nil, nil, err
	}
	chain = append(chain, CountedSlotStep{
		EncryptedCandidateVector: visible, VectorBallotValidityProof: visibleProof,
		CountedVector: sub.Vector, CountedSlotProof: sub.Proof,
	})
	return sub.Vector, chain, nil
}
