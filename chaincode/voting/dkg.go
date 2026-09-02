package main

import (
	"crypto/ecdh"
	"crypto/ed25519"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math/big"
	"sort"
	"strings"

	"github.com/hyperledger/fabric-contract-api-go/contractapi"
)

func validateDKGParticipantKeys(participant dkgParticipant) error {
	transportDER, err := base64.StdEncoding.Strict().DecodeString(participant.TransportPublicKeyDER)
	if err != nil || base64.StdEncoding.EncodeToString(transportDER) != participant.TransportPublicKeyDER {
		return fmt.Errorf("DKG participant transport key encoding invalid")
	}
	transportKey, err := x509.ParsePKIXPublicKey(transportDER)
	if err != nil {
		return fmt.Errorf("DKG participant transport key parse failed")
	}
	x25519, ok := transportKey.(*ecdh.PublicKey)
	if !ok || x25519.Curve() != ecdh.X25519() {
		return fmt.Errorf("DKG participant transport key must be X25519")
	}
	signingDER, err := base64.StdEncoding.Strict().DecodeString(participant.SigningPublicKeyDER)
	if err != nil || base64.StdEncoding.EncodeToString(signingDER) != participant.SigningPublicKeyDER {
		return fmt.Errorf("DKG participant signing key encoding invalid")
	}
	signingKey, err := x509.ParsePKIXPublicKey(signingDER)
	if err != nil {
		return fmt.Errorf("DKG participant signing key parse failed")
	}
	if _, ok := signingKey.(ed25519.PublicKey); !ok {
		return fmt.Errorf("DKG participant signing key must be Ed25519")
	}
	return nil
}

type dkgGroup struct {
	P string `json:"p"`
	G string `json:"g"`
	Q string `json:"q"`
}

type dkgParticipant struct {
	ID                    string `json:"id"`
	Index                 int    `json:"index"`
	TransportPublicKeyDER string `json:"transportPublicKeyDer"`
	SigningPublicKeyDER   string `json:"signingPublicKeyDer"`
}

type dkgCommitments struct {
	Constant string `json:"constant"`
	Linear   string `json:"linear"`
}

type dkgPublicContribution struct {
	DealerID         string         `json:"dealerID"`
	Commitments      dkgCommitments `json:"commitments"`
	ContributionHash string         `json:"contributionHash"`
}

type dkgPublicShare struct {
	Schema       string `json:"schema"`
	CeremonyID   string `json:"ceremonyID"`
	TrusteeID    string `json:"trusteeID"`
	TrusteeIndex int    `json:"trusteeIndex"`
	PublicKeyY   string `json:"publicKeyY"`
}

type dkgTranscript struct {
	Schema             string                  `json:"schema"`
	CeremonyID         string                  `json:"ceremonyID"`
	Threshold          int                     `json:"threshold"`
	TotalTrustees      int                     `json:"totalTrustees"`
	Group              dkgGroup                `json:"group"`
	Participants       []dkgParticipant        `json:"participants"`
	Contributions      []dkgPublicContribution `json:"contributions"`
	PublicShares       []dkgPublicShare        `json:"publicShares"`
	ElectionPublicKeyY string                  `json:"electionPublicKeyY"`
	TranscriptHash     string                  `json:"transcriptHash"`
}

func canonicalTranscriptHash(raw []byte) (string, error) {
	var value map[string]interface{}
	decoder := json.NewDecoder(strings.NewReader(string(raw)))
	decoder.UseNumber()
	if err := decoder.Decode(&value); err != nil {
		return "", err
	}
	delete(value, "transcriptHash")
	canonical, err := json.Marshal(value) // encoding/json sorts string map keys.
	if err != nil {
		return "", err
	}
	digest := sha256.Sum256(canonical)
	return hex.EncodeToString(digest[:]), nil
}

func parseDKGElement(value, label string) (*big.Int, error) {
	if value == "" || strings.ToLower(value) != value || (len(value) > 1 && value[0] == '0') {
		return nil, fmt.Errorf("%s canonical hex invalid", label)
	}
	parsed, ok := new(big.Int).SetString(value, 16)
	if !ok || parsed.Cmp(big.NewInt(1)) <= 0 || parsed.Cmp(elgamalP) >= 0 ||
		new(big.Int).Exp(parsed, elgamalQ, elgamalP).Cmp(big.NewInt(1)) != 0 {
		return nil, fmt.Errorf("%s subgroup element invalid", label)
	}
	return parsed, nil
}

func parseAndValidateDKGTranscript(raw []byte) (*dkgTranscript, []ThresholdPublicShare, error) {
	var transcript dkgTranscript
	decoder := json.NewDecoder(strings.NewReader(string(raw)))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&transcript); err != nil {
		return nil, nil, fmt.Errorf("DKG transcript parse failed: %w", err)
	}
	if transcript.Schema != "mongbas-feldman-dkg-transcript/v1" || transcript.Threshold != ShamirThreshold ||
		transcript.TotalTrustees != ShamirTotalShares || transcript.CeremonyID == "" ||
		transcript.Group.P != elgamalP.Text(16) || transcript.Group.G != elgamalG.Text(16) ||
		transcript.Group.Q != elgamalQ.Text(16) || len(transcript.Participants) != ShamirTotalShares ||
		len(transcript.Contributions) != ShamirTotalShares || len(transcript.PublicShares) != ShamirTotalShares {
		return nil, nil, fmt.Errorf("DKG transcript parameters invalid")
	}
	computedHash, err := canonicalTranscriptHash(raw)
	if err != nil || computedHash != transcript.TranscriptHash || len(transcript.TranscriptHash) != 64 {
		return nil, nil, fmt.Errorf("DKG transcript canonical hash mismatch")
	}
	expectedMSPs := []string{shareIndexMSP["1"], shareIndexMSP["2"], shareIndexMSP["3"]}
	participantByID := make(map[string]dkgParticipant, ShamirTotalShares)
	for _, participant := range transcript.Participants {
		if participant.Index < 1 || participant.Index > ShamirTotalShares || participant.ID != expectedMSPs[participant.Index-1] ||
			participant.TransportPublicKeyDER == "" || participant.SigningPublicKeyDER == "" || participantByID[participant.ID].ID != "" {
			return nil, nil, fmt.Errorf("DKG participant roster invalid")
		}
		if err := validateDKGParticipantKeys(participant); err != nil {
			return nil, nil, err
		}
		participantByID[participant.ID] = participant
	}
	commitmentByDealer := make(map[string]dkgCommitments, ShamirTotalShares)
	for _, contribution := range transcript.Contributions {
		if participantByID[contribution.DealerID].ID == "" || commitmentByDealer[contribution.DealerID].Constant != "" ||
			len(contribution.ContributionHash) != 64 {
			return nil, nil, fmt.Errorf("DKG public contribution invalid")
		}
		if _, err := hex.DecodeString(contribution.ContributionHash); err != nil {
			return nil, nil, fmt.Errorf("DKG contribution hash invalid")
		}
		if _, err := parseDKGElement(contribution.Commitments.Constant, "DKG constant commitment"); err != nil {
			return nil, nil, err
		}
		if _, err := parseDKGElement(contribution.Commitments.Linear, "DKG linear commitment"); err != nil {
			return nil, nil, err
		}
		commitmentByDealer[contribution.DealerID] = contribution.Commitments
	}
	electionY, err := parseDKGElement(transcript.ElectionPublicKeyY, "DKG election public key")
	if err != nil {
		return nil, nil, err
	}
	expectedElectionY := big.NewInt(1)
	for _, mspID := range expectedMSPs {
		constant, _ := new(big.Int).SetString(commitmentByDealer[mspID].Constant, 16)
		expectedElectionY.Mul(expectedElectionY, constant).Mod(expectedElectionY, elgamalP)
	}
	if electionY.Cmp(expectedElectionY) != 0 {
		return nil, nil, fmt.Errorf("DKG election public key commitment mismatch")
	}
	shares := make([]ThresholdPublicShare, ShamirTotalShares)
	seenIndexes := make(map[int]bool, ShamirTotalShares)
	for _, published := range transcript.PublicShares {
		if published.Schema != "mongbas-dkg-public-share/v1" || published.CeremonyID != transcript.CeremonyID ||
			published.TrusteeIndex < 1 || published.TrusteeIndex > ShamirTotalShares || seenIndexes[published.TrusteeIndex] ||
			published.TrusteeID != expectedMSPs[published.TrusteeIndex-1] {
			return nil, nil, fmt.Errorf("DKG public trustee share metadata invalid")
		}
		actual, err := parseDKGElement(published.PublicKeyY, "DKG public trustee share")
		if err != nil {
			return nil, nil, err
		}
		expected := big.NewInt(1)
		for _, mspID := range expectedMSPs {
			commitment := commitmentByDealer[mspID]
			constant, _ := new(big.Int).SetString(commitment.Constant, 16)
			linear, _ := new(big.Int).SetString(commitment.Linear, 16)
			expected.Mul(expected, constant).Mod(expected, elgamalP)
			expected.Mul(expected, new(big.Int).Exp(linear, big.NewInt(int64(published.TrusteeIndex)), elgamalP)).Mod(expected, elgamalP)
		}
		if actual.Cmp(expected) != 0 {
			return nil, nil, fmt.Errorf("DKG public trustee share commitment mismatch: %d", published.TrusteeIndex)
		}
		seenIndexes[published.TrusteeIndex] = true
		shares[published.TrusteeIndex-1] = ThresholdPublicShare{Index: published.TrusteeIndex,
			MSPID: published.TrusteeID, PublicKeyY: published.PublicKeyY}
	}
	return &transcript, shares, nil
}

// ApproveDKGTranscript binds the independently exchanged ceremony transcript
// to each Fabric MSP. DKG-backed elections cannot be activated until all three
// trustee organizations approve the exact same canonical hash.
func (c *VotingContract) ApproveDKGTranscript(ctx contractapi.TransactionContextInterface, electionID, shareIndex, transcriptHash string) (*Election, error) {
	if err := requireShareOwner(ctx, shareIndex); err != nil {
		return nil, err
	}
	election, err := c.GetElection(ctx, electionID)
	if err != nil {
		return nil, err
	}
	if election.Status != "CREATED" || election.KeyCeremonyMode != "dkg-v1" || election.DKGTranscriptHash != transcriptHash {
		return nil, fmt.Errorf("DKG transcript approval does not match a pending DKG election")
	}
	mspID := shareIndexMSP[shareIndex]
	for _, approved := range election.DKGApprovals {
		if approved == mspID {
			return election, nil
		}
	}
	election.DKGApprovals = append(election.DKGApprovals, mspID)
	sort.Strings(election.DKGApprovals)
	encoded, err := json.Marshal(election)
	if err != nil {
		return nil, err
	}
	if err := ctx.GetStub().PutState(electionID, encoded); err != nil {
		return nil, err
	}
	return election, nil
}
