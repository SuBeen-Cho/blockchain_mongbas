package main

import (
	"crypto/sha256"
	"fmt"
	"math/big"
	"strings"
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

func TestVectorAuditArtifactHashMatchesNodeVector(t *testing.T) {
	vector := []ElGamalCiphertext{{C1: "2", C2: "3"}, {C1: "4", C2: "5"}}
	proof := &VectorBallotValidityProof{
		BitProofs: []*BallotValidityProof{
			{A1s: []string{"6", "7"}, A2s: []string{"8", "9"}, Es: []string{"a", "b"}, Zs: []string{"c", "d"}},
			{A1s: []string{"e", "f"}, A2s: []string{"10", "11"}, Es: []string{"12", "13"}, Zs: []string{"14", "15"}},
		},
		SumProof: &EqualityOfDiscreteLogsProof{A1: "16", A2: "17", E: "18", Z: "19"},
	}
	got, err := computeVectorAuditArtifactHash("election-a", []string{"A", "B"}, vector, proof)
	if err != nil {
		t.Fatal(err)
	}
	const want = "8acdff8ddc9153e0139509e77abb7f0ae909006380fdceacf39a8d6178de7246"
	if got != want {
		t.Fatalf("cross-language artifact hash mismatch: got %s want %s", got, want)
	}
	changed, err := computeVectorAuditArtifactHash("election-a", []string{"B", "A"}, vector, proof)
	if err != nil {
		t.Fatal(err)
	}
	if changed == got {
		t.Fatal("candidate order was not bound into artifact hash")
	}
}

func proveDisjunctionForTest(pub *ElGamalPublicKey, ciphertext ElGamalCiphertext,
	messages []*big.Int, actual int, nonce, witness *big.Int, domain string) *BallotValidityProof {
	y, _ := new(big.Int).SetString(pub.Y, 16)
	c1, _ := new(big.Int).SetString(ciphertext.C1, 16)
	c2, _ := new(big.Int).SetString(ciphertext.C2, 16)
	proof := &BallotValidityProof{A1s: make([]string, len(messages)), A2s: make([]string, len(messages)), Es: make([]string, len(messages)), Zs: make([]string, len(messages))}
	sumSimulated := big.NewInt(0)
	for i, message := range messages {
		if i == actual {
			proof.A1s[i] = new(big.Int).Exp(elgamalG, nonce, elgamalP).Text(16)
			proof.A2s[i] = new(big.Int).Exp(y, nonce, elgamalP).Text(16)
			continue
		}
		e := big.NewInt(int64(11 + i))
		z := big.NewInt(int64(23 + i))
		adjusted := new(big.Int).Mul(c2, new(big.Int).ModInverse(message, elgamalP))
		adjusted.Mod(adjusted, elgamalP)
		a1 := new(big.Int).Mul(new(big.Int).Exp(elgamalG, z, elgamalP),
			new(big.Int).ModInverse(new(big.Int).Exp(c1, e, elgamalP), elgamalP))
		a1.Mod(a1, elgamalP)
		a2 := new(big.Int).Mul(new(big.Int).Exp(y, z, elgamalP),
			new(big.Int).ModInverse(new(big.Int).Exp(adjusted, e, elgamalP), elgamalP))
		a2.Mod(a2, elgamalP)
		proof.A1s[i], proof.A2s[i], proof.Es[i], proof.Zs[i] = a1.Text(16), a2.Text(16), e.Text(16), z.Text(16)
		sumSimulated.Add(sumSimulated, e)
	}
	transcript := domain + "|" + elgamalG.Text(16) + "|" + y.Text(16) + "|" + c1.Text(16) + "|" + c2.Text(16)
	for i, message := range messages {
		transcript += "|" + message.Text(16) + "|" + proof.A1s[i] + "|" + proof.A2s[i]
	}
	digest := sha256.Sum256([]byte(transcript))
	challenge := new(big.Int).SetBytes(digest[:])
	challenge.Mod(challenge, elgamalQ)
	eActual := new(big.Int).Sub(challenge, sumSimulated)
	eActual.Mod(eActual, elgamalQ)
	zActual := new(big.Int).Mul(eActual, witness)
	zActual.Add(zActual, nonce).Mod(zActual, elgamalQ)
	proof.Es[actual], proof.Zs[actual] = eActual.Text(16), zActual.Text(16)
	return proof
}

func proveEqualityForTest(base1, base2, result1, result2, witness, nonce *big.Int, domain string) *EqualityOfDiscreteLogsProof {
	a1 := new(big.Int).Exp(base1, nonce, elgamalP)
	a2 := new(big.Int).Exp(base2, nonce, elgamalP)
	transcript := domain + "|" + base1.Text(16) + "|" + base2.Text(16) + "|" + result1.Text(16) + "|" + result2.Text(16) + "|" + a1.Text(16) + "|" + a2.Text(16)
	digest := sha256.Sum256([]byte(transcript))
	e := new(big.Int).SetBytes(digest[:])
	e.Mod(e, elgamalQ)
	z := new(big.Int).Mul(e, witness)
	z.Add(z, nonce).Mod(z, elgamalQ)
	return &EqualityOfDiscreteLogsProof{A1: a1.Text(16), A2: a2.Text(16), E: e.Text(16), Z: z.Text(16)}
}

func vectorBallotForTest(pub *ElGamalPublicKey, selected, size int) ([]ElGamalCiphertext, *VectorBallotValidityProof) {
	y, _ := new(big.Int).SetString(pub.Y, 16)
	messages := []*big.Int{big.NewInt(1), new(big.Int).Set(elgamalG)}
	ciphertexts := make([]ElGamalCiphertext, size)
	proof := &VectorBallotValidityProof{BitProofs: make([]*BallotValidityProof, size)}
	rSum, productC1, productC2 := big.NewInt(0), big.NewInt(1), big.NewInt(1)
	for i := 0; i < size; i++ {
		bit := 0
		if i == selected {
			bit = 1
		}
		r := big.NewInt(int64(31 + i))
		c1 := new(big.Int).Exp(elgamalG, r, elgamalP)
		c2 := new(big.Int).Exp(y, r, elgamalP)
		if bit == 1 {
			c2.Mul(c2, elgamalG).Mod(c2, elgamalP)
		}
		ciphertexts[i] = ElGamalCiphertext{C1: c1.Text(16), C2: c2.Text(16)}
		proof.BitProofs[i] = proveDisjunctionForTest(pub, ciphertexts[i], messages, bit, big.NewInt(int64(71+i)), r, "mongbas/vector-v3/bit/"+big.NewInt(int64(i)).String())
		rSum.Add(rSum, r).Mod(rSum, elgamalQ)
		productC1.Mul(productC1, c1).Mod(productC1, elgamalP)
		productC2.Mul(productC2, c2).Mod(productC2, elgamalP)
	}
	productC2DivG := new(big.Int).Mul(productC2, new(big.Int).ModInverse(elgamalG, elgamalP))
	productC2DivG.Mod(productC2DivG, elgamalP)
	proof.SumProof = proveEqualityForTest(elgamalG, y, productC1, productC2DivG, rSum, big.NewInt(101), "mongbas/vector-v3/sum")
	return ciphertexts, proof
}

func TestVectorBallotOneHotProofAndTampering(t *testing.T) {
	_, pub := elgamalGenerateKeyPair([]byte("vector-v3-known-answer"))
	ciphertexts, proof := vectorBallotForTest(pub, 1, 3)
	if !verifyVectorBallotValidityZKP(pub, ciphertexts, proof) {
		t.Fatal("valid one-hot vector ballot was rejected")
	}
	tampered := append([]ElGamalCiphertext(nil), ciphertexts...)
	tampered[0].C2 = new(big.Int).Mul(elgamalG, elgamalG).Text(16)
	if verifyVectorBallotValidityZKP(pub, tampered, proof) {
		t.Fatal("tampered vector ciphertext was accepted")
	}
	tamperedProof := *proof
	tamperedSum := *proof.SumProof
	tamperedSum.Z = "0"
	tamperedProof.SumProof = &tamperedSum
	if verifyVectorBallotValidityZKP(pub, ciphertexts, &tamperedProof) {
		t.Fatal("tampered one-hot sum proof was accepted")
	}
}

func TestVectorAggregateThresholdDecryptionScalesByVotesNotCandidates(t *testing.T) {
	secret, pub := elgamalGenerateKeyPair([]byte("vector-v3-threshold"))
	coefficient := new(big.Int).SetBytes([]byte("vector-v3-coefficient"))
	coefficient.Mod(coefficient, elgamalQ)
	shares, err := deriveThresholdShares(secret, coefficient, 3)
	if err != nil {
		t.Fatal(err)
	}
	want := []int{37, 41, 22}
	for candidateIndex, expected := range want {
		accC1, accC2 := big.NewInt(1), big.NewInt(1)
		for vote := 0; vote < 100; vote++ {
			bit := 0
			if vote >= prefixSum(want, candidateIndex) && vote < prefixSum(want, candidateIndex+1) {
				bit = 1
			}
			r := big.NewInt(int64(1000 + candidateIndex*100 + vote))
			y, _ := new(big.Int).SetString(pub.Y, 16)
			c1 := new(big.Int).Exp(elgamalG, r, elgamalP)
			c2 := new(big.Int).Exp(y, r, elgamalP)
			if bit == 1 {
				c2.Mul(c2, elgamalG).Mod(c2, elgamalP)
			}
			accC1.Mul(accC1, c1).Mod(accC1, elgamalP)
			accC2.Mul(accC2, c2).Mod(accC2, elgamalP)
		}
		partials := map[int]*big.Int{
			1: new(big.Int).Exp(accC1, shares[0], elgamalP),
			3: new(big.Int).Exp(accC1, shares[2], elgamalP),
		}
		combined, combineErr := combinePartialDecryptionValues(partials)
		if combineErr != nil {
			t.Fatal(combineErr)
		}
		gm := new(big.Int).Mul(accC2, new(big.Int).ModInverse(combined, elgamalP))
		gm.Mod(gm, elgamalP)
		got, bsgsErr := babyStepGiantStep(gm, elgamalG, elgamalP, 101)
		if bsgsErr != nil || int(got) != expected {
			t.Fatalf("candidate %d: want %d got %d err=%v", candidateIndex, expected, got, bsgsErr)
		}
	}
}

func prefixSum(values []int, end int) int {
	total := 0
	for i := 0; i < end && i < len(values); i++ {
		total += values[i]
	}
	return total
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

func TestBaseBEncodingRoundTripWithinCapacity(t *testing.T) {
	testCases := [][]int{
		{0},
		{1, 1},
		{17, 29},
		{9999, 0},
		{3, 7, 11},
	}
	for _, want := range testCases {
		sum := int64(0)
		place := int64(1)
		for _, count := range want {
			sum += int64(count) * place
			place *= HomomorphicBase
		}
		got := decomposeBaseB(sum, len(want))
		for i := range want {
			if got[i] != want[i] {
				t.Fatalf("round trip %v: index %d got %d", want, i, got[i])
			}
		}
	}
}

func TestHomomorphicCapacityRejectsAmbiguousOrInfeasibleTallies(t *testing.T) {
	if err := validateHomomorphicTallyCapacity(HomomorphicBase, 2); err == nil {
		t.Fatal("a vote count equal to the digit base must be rejected")
	}
	if err := validateHomomorphicTallyCapacity(40, 3); err == nil {
		t.Fatal("a tally beyond the configured BSGS search bound must be rejected")
	}
	if err := validateHomomorphicTallyCapacity(39, 3); err != nil {
		t.Fatalf("boundary tally should fit: %v", err)
	}
	if err := validateHomomorphicTallyCapacity(1, 10); err == nil {
		t.Fatal("overflowing candidate encoding must be rejected")
	}
}

func TestHMACCredentialFailsClosedWithoutStrongSecret(t *testing.T) {
	t.Setenv("CREDENTIAL_SECRET", "")
	err := verifyHMACCredentialToken(nil, CredentialVerification{}, "election", 1)
	if err == nil || !strings.Contains(err.Error(), "미설정") {
		t.Fatalf("missing HMAC secret must fail closed, got %v", err)
	}

	t.Setenv("CREDENTIAL_SECRET", "too-short")
	err = verifyHMACCredentialToken(nil, CredentialVerification{}, "election", 1)
	if err == nil || !strings.Contains(err.Error(), "너무 짧") {
		t.Fatalf("short HMAC secret must fail closed, got %v", err)
	}
}

func TestCredentialBoundNullifierIsDeterministicAndElectionScoped(t *testing.T) {
	wantRaw := sha256.Sum256([]byte("signed-material" + "election-a" + "blind-a"))
	want := fmt.Sprintf("%x", wantRaw)
	got, err := computeCredentialBoundNullifier("signed-material", "election-a", "blind-a")
	if err != nil || got != want {
		t.Fatalf("bound nullifier mismatch: got=%s want=%s err=%v", got, want, err)
	}
	again, _ := computeCredentialBoundNullifier("signed-material", "election-a", "blind-a")
	if again != got {
		t.Fatal("credential reissuance material must map to the same nullifier")
	}
	otherElection, _ := computeCredentialBoundNullifier("signed-material", "election-b", "blind-b")
	if otherElection == got {
		t.Fatal("the same credential material must not link to the same nullifier across elections")
	}
	if _, err := computeCredentialBoundNullifier("", "election-a", "blind-a"); err == nil {
		t.Fatal("missing signed material must fail closed")
	}
}

func TestCredentialRevocationHandleIsVersionedAndElectionScoped(t *testing.T) {
	got, err := computeCredentialRevocationHandle("signed-material", "election-a", "blind-a")
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != sha256.Size*2 {
		t.Fatalf("revocation handle must be SHA-256 hex, got %q", got)
	}
	if got != "8cabe1a5ba7fa8135d53ed00af40bad3953e1d814f74c9f33267e5f5489fd6d4" {
		t.Fatalf("cross-language revocation vector changed: %s", got)
	}
	again, _ := computeCredentialRevocationHandle("signed-material", "election-a", "blind-a")
	if again != got {
		t.Fatal("revocation handle must be deterministic")
	}
	otherElection, _ := computeCredentialRevocationHandle("signed-material", "election-b", "blind-b")
	if otherElection == got {
		t.Fatal("revocation handle must be election scoped")
	}
	legacy, _ := computeCredentialBoundNullifier("signed-material", "election-a", "blind-a")
	if legacy == got {
		t.Fatal("revocation and ballot-nullifier domains must be distinct")
	}
	for _, fields := range [][3]string{{"", "election-a", "blind-a"}, {"signed-material", "", "blind-a"}, {"signed-material", "election-a", ""}} {
		if _, err := computeCredentialRevocationHandle(fields[0], fields[1], fields[2]); err == nil {
			t.Fatalf("missing revocation input must fail: %#v", fields)
		}
	}
}

func TestCredentialRevocationStateKeyAndReasonsFailClosed(t *testing.T) {
	handle, err := computeCredentialRevocationHandle("signed-material", "election-a", "blind-a")
	if err != nil {
		t.Fatal(err)
	}
	key, err := credentialRevocationStateKey("election-a", handle)
	if err != nil || !strings.HasPrefix(key, "REVOCATION_") || len(key) != len("REVOCATION_")+sha256.Size*2 {
		t.Fatalf("unexpected revocation key %q: %v", key, err)
	}
	if same, _ := credentialRevocationStateKey("election-a", handle); same != key {
		t.Fatal("revocation state key must be deterministic")
	}
	if other, _ := credentialRevocationStateKey("election-b", handle); other == key {
		t.Fatal("revocation state key must be election scoped")
	}
	for _, malformed := range []string{"", "00", strings.ToUpper(handle), strings.Repeat("g", 64)} {
		if _, err := credentialRevocationStateKey("election-a", malformed); err == nil {
			t.Fatalf("malformed revocation handle accepted: %q", malformed)
		}
	}
	for _, reason := range []string{"eligibility-withdrawn", "credential-compromised", "issued-in-error"} {
		if !validCredentialRevocationReason(reason) {
			t.Fatalf("documented reason rejected: %s", reason)
		}
	}
	for _, reason := range []string{"", "other", "voter name", "credential-compromised\npii"} {
		if validCredentialRevocationReason(reason) {
			t.Fatalf("unsafe revocation reason accepted: %q", reason)
		}
	}
}

func TestThresholdPartialDecryptionsReconstructWithoutSecret(t *testing.T) {
	secret, pub := elgamalGenerateKeyPair([]byte("threshold-partial-known-answer"))
	coefficient := new(big.Int).SetBytes([]byte("independent-coefficient"))
	coefficient.Mod(coefficient, elgamalQ)
	shares, err := deriveThresholdShares(secret, coefficient, 3)
	if err != nil {
		t.Fatal(err)
	}
	c1Hex, c2Hex := encryptExponentialForTest(secret, 1, 37)
	c1, _ := new(big.Int).SetString(c1Hex, 16)
	c2, _ := new(big.Int).SetString(c2Hex, 16)

	for _, indexes := range [][]int{{1, 2}, {1, 3}, {2, 3}} {
		partials := make(map[int]*big.Int)
		for _, index := range indexes {
			partials[index] = new(big.Int).Exp(c1, shares[index-1], elgamalP)
		}
		combined, err := combinePartialDecryptionValues(partials)
		if err != nil {
			t.Fatalf("subset %v failed: %v", indexes, err)
		}
		inv := new(big.Int).ModInverse(combined, elgamalP)
		gm := new(big.Int).Mod(new(big.Int).Mul(c2, inv), elgamalP)
		want := expElGamalEncodeCandidate(1)
		if gm.Cmp(want) != 0 {
			t.Fatalf("subset %v recovered wrong plaintext", indexes)
		}

		// Each partial share is independently verifiable without the secret.
		for _, index := range indexes {
			publicShare := &ElGamalPublicKey{P: pub.P, G: pub.G, Y: new(big.Int).Exp(elgamalG, shares[index-1], elgamalP).Text(16)}
			proof, err := chaumPedersenProveRaw(shares[index-1], c1Hex, partials[index].Text(16), "1", "PARTIAL", "election", "")
			if err != nil || !chaumPedersenVerifyRaw(publicShare, proof, big.NewInt(1)) {
				t.Fatalf("valid partial proof %d rejected: %v", index, err)
			}
			tampered := *proof
			tampered.Z = "0"
			if chaumPedersenVerifyRaw(publicShare, &tampered, big.NewInt(1)) {
				t.Fatalf("tampered partial proof %d accepted", index)
			}
		}
	}

	if _, err := combinePartialDecryptionValues(map[int]*big.Int{1: new(big.Int).Exp(c1, shares[0], elgamalP)}); err == nil {
		t.Fatal("threshold-minus-one partial set was accepted")
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

func TestChaumPedersenRejectsZeroChallengeForgery(t *testing.T) {
	_, pub := elgamalGenerateKeyPair([]byte("forgery-public-key"))
	forged := &ChaumPedersenProof{
		C1: "2",
		C2: "2",
		A1: "2",
		A2: "2",
		E:  "0",
		Z:  "1",
	}
	if chaumPedersenVerifyRaw(pub, forged, big.NewInt(1)) {
		t.Fatal("zero-challenge proof forgery was accepted")
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

func FuzzProofVerifiersNeverPanic(f *testing.F) {
	f.Add("", "", "", "", "", "")
	f.Add("not-hex", "0", "-1", "01", "ffffffff", "zz")
	f.Fuzz(func(t *testing.T, c1, c2, a1, a2, e, z string) {
		_, pub := elgamalGenerateKeyPair([]byte("fuzz-public-key"))
		proof := &ChaumPedersenProof{C1: c1, C2: c2, A1: a1, A2: a2, E: e, Z: z}
		defer func() {
			if recovered := recover(); recovered != nil {
				t.Fatalf("proof verifier panicked: %v", recovered)
			}
		}()
		_ = chaumPedersenVerify(pub, proof, "ALICE")
		_ = chaumPedersenVerifyRaw(pub, proof, big.NewInt(1))
	})
}
