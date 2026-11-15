package main

import (
	"encoding/json"
	"os"
	"testing"
)

type slotFixtureFile struct {
	PubKey struct {
		P string `json:"p"`
		G string `json:"g"`
		Y string `json:"y"`
	} `json:"pubKey"`
	ElectionID    string `json:"electionID"`
	NullifierHash string `json:"nullifierHash"`
	Cases         []struct {
		Name     string                `json:"name"`
		Visible  []ElGamalCiphertext   `json:"visible"`
		Previous []ElGamalCiphertext   `json:"previous"`
		Slot     CountedSlotSubmission `json:"slot"`
		Valid    bool                  `json:"valid"`
	} `json:"cases"`
}

// Fixtures are produced by frontend/src/utils/countedSlot.js, so this test
// pins byte-level compatibility between the device prover and the chaincode.
func TestDeniableSlotVerifiesBrowserProofs(t *testing.T) {
	raw, err := os.ReadFile("testdata/deniable_slot_fixtures.json")
	if err != nil {
		t.Fatal(err)
	}
	var f slotFixtureFile
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatal(err)
	}
	pub := &ElGamalPublicKey{P: f.PubKey.P, G: f.PubKey.G, Y: f.PubKey.Y}
	for _, c := range f.Cases {
		old := c.Previous
		if old == nil {
			old = trivialZeroSlot(len(c.Visible))
		}
		err := verifyCountedSlot(pub, f.ElectionID, f.NullifierHash, c.Visible, old, c.Slot.Vector, c.Slot.Proof)
		if c.Valid && err != nil {
			t.Fatalf("%s: valid proof rejected: %v", c.Name, err)
		}
		if !c.Valid && err == nil {
			t.Fatalf("%s: invalid proof accepted", c.Name)
		}
		// binding: the same proof must fail under another nullifier/election context
		if c.Valid {
			if verifyCountedSlot(pub, f.ElectionID, "cd"+f.NullifierHash[2:], c.Visible, old, c.Slot.Vector, c.Slot.Proof) == nil {
				t.Fatalf("%s: proof not bound to nullifier", c.Name)
			}
			if verifyCountedSlot(pub, f.ElectionID+"-X", f.NullifierHash, c.Visible, old, c.Slot.Vector, c.Slot.Proof) == nil {
				t.Fatalf("%s: proof not bound to election", c.Name)
			}
		}
	}
}

func TestDeniableSlotRejectsMalformedProof(t *testing.T) {
	pub := &ElGamalPublicKey{Y: "4"}
	v := trivialZeroSlot(3)
	if verifyCountedSlot(pub, "E", "N", v, v, v, CountedSlotProof{Schema: PanicPolicyDeniableSlot}) == nil {
		t.Fatal("malformed proof accepted")
	}
}
