package main

import (
	"crypto/ecdh"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"math/big"
	"testing"
)

func dkgTranscriptFixture(t *testing.T) []byte {
	t.Helper()
	msps := []string{"ElectionCommissionMSP", "PartyObserverMSP", "CivilSocietyMSP"}
	constants := []*big.Int{big.NewInt(11), big.NewInt(17), big.NewInt(23)}
	linears := []*big.Int{big.NewInt(5), big.NewInt(7), big.NewInt(13)}
	transcript := dkgTranscript{
		Schema: "mongbas-feldman-dkg-transcript/v1", CeremonyID: "go-dkg-fixture",
		Threshold: 2, TotalTrustees: 3,
		Group: dkgGroup{P: elgamalP.Text(16), G: elgamalG.Text(16), Q: elgamalQ.Text(16)},
	}
	for index, mspID := range msps {
		transportPrivate, err := ecdh.X25519().GenerateKey(rand.Reader)
		if err != nil {
			t.Fatal(err)
		}
		transportDER, _ := x509.MarshalPKIXPublicKey(transportPrivate.PublicKey())
		_, signingKey, _ := ed25519.GenerateKey(rand.Reader)
		signingDER, _ := x509.MarshalPKIXPublicKey(signingKey.Public())
		transcript.Participants = append(transcript.Participants, dkgParticipant{
			ID: mspID, Index: index + 1,
			TransportPublicKeyDER: base64.StdEncoding.EncodeToString(transportDER),
			SigningPublicKeyDER:   base64.StdEncoding.EncodeToString(signingDER),
		})
		commitments := dkgCommitments{
			Constant: new(big.Int).Exp(elgamalG, constants[index], elgamalP).Text(16),
			Linear:   new(big.Int).Exp(elgamalG, linears[index], elgamalP).Text(16),
		}
		transcript.Contributions = append(transcript.Contributions, dkgPublicContribution{
			DealerID: mspID, Commitments: commitments,
			ContributionHash: hex.EncodeToString(sha256.New().Sum([]byte{byte(index + 1)}))[:64],
		})
	}
	secret := big.NewInt(0)
	linear := big.NewInt(0)
	for index := range constants {
		secret.Add(secret, constants[index]).Mod(secret, elgamalQ)
		linear.Add(linear, linears[index]).Mod(linear, elgamalQ)
	}
	transcript.ElectionPublicKeyY = new(big.Int).Exp(elgamalG, secret, elgamalP).Text(16)
	for index, mspID := range msps {
		share := new(big.Int).Mul(linear, big.NewInt(int64(index+1)))
		share.Add(share, secret).Mod(share, elgamalQ)
		transcript.PublicShares = append(transcript.PublicShares, dkgPublicShare{
			Schema: "mongbas-dkg-public-share/v1", CeremonyID: transcript.CeremonyID,
			TrusteeID: mspID, TrusteeIndex: index + 1,
			PublicKeyY: new(big.Int).Exp(elgamalG, share, elgamalP).Text(16),
		})
	}
	raw, _ := json.Marshal(transcript)
	hash, err := canonicalTranscriptHash(raw)
	if err != nil {
		t.Fatal(err)
	}
	transcript.TranscriptHash = hash
	raw, _ = json.Marshal(transcript)
	return raw
}

func TestParseAndValidateDKGTranscript(t *testing.T) {
	raw := dkgTranscriptFixture(t)
	transcript, shares, err := parseAndValidateDKGTranscript(raw)
	if err != nil {
		t.Fatal(err)
	}
	if transcript.TranscriptHash == "" || len(shares) != 3 || shares[0].MSPID != "ElectionCommissionMSP" {
		t.Fatal("validated DKG transcript lost required public bindings")
	}
}

func TestDKGTranscriptMutationsFailClosed(t *testing.T) {
	for name, mutate := range map[string]func(map[string]interface{}){
		"hash": func(value map[string]interface{}) { value["transcriptHash"] = string(make([]byte, 64)) },
		"public share": func(value map[string]interface{}) {
			value["publicShares"].([]interface{})[0].(map[string]interface{})["publicKeyY"] = "2"
		},
		"group": func(value map[string]interface{}) { value["group"].(map[string]interface{})["g"] = "4" },
		"participant index": func(value map[string]interface{}) {
			value["participants"].([]interface{})[0].(map[string]interface{})["index"] = float64(2)
		},
	} {
		t.Run(name, func(t *testing.T) {
			var value map[string]interface{}
			if err := json.Unmarshal(dkgTranscriptFixture(t), &value); err != nil {
				t.Fatal(err)
			}
			mutate(value)
			raw, _ := json.Marshal(value)
			if _, _, err := parseAndValidateDKGTranscript(raw); err == nil {
				t.Fatal("mutated DKG transcript was accepted")
			}
		})
	}
}
