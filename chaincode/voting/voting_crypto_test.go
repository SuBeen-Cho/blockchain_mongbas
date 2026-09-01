package main

import (
	"crypto/sha256"
	"math/big"
	"testing"
)

func encryptExponentialForTest(x *big.Int, candidateIndex int, nonce int64) (string, string) {
	r := big.NewInt(nonce)
	y := new(big.Int).Exp(elgamalG, x, elgamalP)
	c1 := new(big.Int).Exp(elgamalG, r, elgamalP)
	c2 := new(big.Int).Exp(y, r, elgamalP)
	c2.Mul(c2, expElGamalEncodeCandidate(candidateIndex))
	c2.Mod(c2, elgamalP)
	return c1.Text(16), c2.Text(16)
}

func TestExponentialElGamalAggregateOneToOne(t *testing.T) {
	x, _ := elgamalGenerateKeyPair([]byte("aggregate-1-to-1-known-answer"))
	a1, a2 := encryptExponentialForTest(x, 0, 17)
	b1, b2 := encryptExponentialForTest(x, 1, 29)

	c1a, _ := new(big.Int).SetString(a1, 16)
	c2a, _ := new(big.Int).SetString(a2, 16)
	c1b, _ := new(big.Int).SetString(b1, 16)
	c2b, _ := new(big.Int).SetString(b2, 16)
	aggC1 := new(big.Int).Mul(c1a, c1b)
	aggC1.Mod(aggC1, elgamalP)
	aggC2 := new(big.Int).Mul(c2a, c2b)
	aggC2.Mod(aggC2, elgamalP)

	gm, err := expElGamalDecryptToGm(x, aggC1.Text(16), aggC2.Text(16))
	if err != nil {
		t.Fatalf("aggregate decryption failed: %v", err)
	}
	sum, err := babyStepGiantStep(gm, elgamalG, elgamalP, HomomorphicBase*HomomorphicBase)
	if err != nil {
		t.Fatalf("discrete log recovery failed: %v", err)
	}
	counts := decomposeBaseB(sum, 2)
	if counts[0] != 1 || counts[1] != 1 {
		t.Fatalf("expected [1 1], got %v (encoded sum %d)", counts, sum)
	}
}

func TestHomomorphicDecryptionProofRejectsTampering(t *testing.T) {
	x, pub := elgamalGenerateKeyPair([]byte("proof-known-answer"))
	c1, c2 := encryptExponentialForTest(x, 1, 31)
	gm, err := expElGamalDecryptToGm(x, c1, c2)
	if err != nil {
		t.Fatal(err)
	}
	h := sha256.Sum256([]byte("homomorphic_sum:10000"))
	proof, err := chaumPedersenProveRaw(x, c1, c2, gm.Text(16), "HOMOMORPHIC_TALLY", "election-test", string(h[:]))
	if err != nil {
		t.Fatal(err)
	}
	if !chaumPedersenVerifyRaw(pub, proof, gm) {
		t.Fatal("valid proof was rejected")
	}
	tampered := *proof
	tampered.Z = "0"
	if chaumPedersenVerifyRaw(pub, &tampered, gm) {
		t.Fatal("tampered proof was accepted")
	}
}

func TestProofVerifiersRejectMalformedInputsWithoutPanic(t *testing.T) {
	_, pub := elgamalGenerateKeyPair([]byte("malformed-proof"))
	malformed := &ChaumPedersenProof{C1: "not-hex", C2: "0", A1: "", A2: "", E: "", Z: ""}
	assertDoesNotPanicAndReturnsFalse(t, func() bool {
		return chaumPedersenVerify(pub, malformed, "ALICE")
	})
	assertDoesNotPanicAndReturnsFalse(t, func() bool {
		return chaumPedersenVerifyRaw(pub, malformed, big.NewInt(1))
	})
	assertDoesNotPanicAndReturnsFalse(t, func() bool {
		return verifyBallotValidityZKP(pub, "not-hex", "0", 1, &BallotValidityProof{
			A1s: []string{""}, A2s: []string{""}, Es: []string{""}, Zs: []string{""},
		})
	})
}

func TestShamirRoundTripAndInvalidIndexes(t *testing.T) {
	secret := sha256.Sum256([]byte("shamir-known-answer"))
	seed := sha256.Sum256([]byte("shamir-coefficient"))
	shares := shamirSplit256(secret[:], 3, seed[:])
	for _, pair := range [][2]int{{1, 2}, {1, 3}, {2, 3}} {
		restored := shamirReconstruct256(shares[pair[0]-1], shares[pair[1]-1], pair[0], pair[1])
		if restored == nil || new(big.Int).SetBytes(restored).Cmp(new(big.Int).SetBytes(secret[:])) != 0 {
			t.Fatalf("pair %v failed to restore secret", pair)
		}
	}
	if restored := shamirReconstruct256(shares[0], shares[0], 1, 1); restored != nil {
		t.Fatal("duplicate share index must fail")
	}
	if restored := shamirReconstruct256(shares[0], shares[1], 0, 2); restored != nil {
		t.Fatal("out-of-range share index must fail")
	}
}

func assertDoesNotPanicAndReturnsFalse(t *testing.T, fn func() bool) {
	t.Helper()
	defer func() {
		if recovered := recover(); recovered != nil {
			t.Fatalf("malformed input caused panic: %v", recovered)
		}
	}()
	if fn() {
		t.Fatal("malformed input was accepted")
	}
}
