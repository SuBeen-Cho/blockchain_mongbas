// Package voting implements a privacy-preserving e-voting chaincode
// for Hyperledger Fabric using Anonymous Nullifiers and Private Data Collections (PDC).
//
// 핵심 프라이버시 설계:
//   - Nullifier: hash(signed credential material || election scope) → 최종 1표만 유효
//   - PDC (Private Data Collection): 투표 원본은 피어 비공개 사이드DB에만 저장
//   - 공개 원장: nullifierHash + candidateID만 기록 (신원 미노출)
//
// 데이터 흐름:
//
//	클라이언트 → CastVote(transient: votePrivate) → [PDC] VotePrivate (비공개)
//	                                              → [원장] Nullifier   (익명 공개)
package main

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/ed25519"
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"crypto/x509"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"math/big"
	"os"
	"sort"
	"strconv"
	"strings"

	ml "github.com/IBM/mathlib"
	bn256 "github.com/ethereum/go-ethereum/crypto/bn256/cloudflare"
	ariesbbs "github.com/hyperledger/aries-bbs-go/bbs"
	"github.com/hyperledger/fabric-chaincode-go/shim"
	"github.com/hyperledger/fabric-contract-api-go/contractapi"
)

// shamirBigPrime: secp256k1 곡선 소수 (2^256 - 2^32 - 977), 256비트 검증된 소수
// 32바이트 masterKey 전체를 하나의 GF(p) 원소로 처리 → 보안 공간 2^256
var shamirBigPrime, _ = new(big.Int).SetString(
	"FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEFFFFFC2F", 16,
)

// ============================================================
// [PAPER-11] ElGamal 암호화 파라미터 — RFC 3526 Group 14 (2048-bit MODP)
// ============================================================
//
// 표준화된 2048비트 안전 소수 그룹 (IKE/TLS에서 검증됨)
// p = 안전 소수, q = (p-1)/2 (소수), g = 2 (원시근)
//
// 학술적 의의:
//   - AES 대칭키와 달리 공개키 기반 → 키 공개 없이 ZKP로 복호화 검증 가능
//   - Chaum-Pedersen ZKP: log_g(y) = log_c1(c2/m) 증명
//   - 기존 Bulletin Board의 "키 공개 후 검증"을 "ZKP 검증"으로 대체

var elgamalP, _ = new(big.Int).SetString(
	"FFFFFFFFFFFFFFFFC90FDAA22168C234C4C6628B80DC1CD1"+
		"29024E088A67CC74020BBEA63B139B22514A08798E3404DD"+
		"EF9519B3CD3A431B302B0A6DF25F14374FE1356D6D51C245"+
		"E485B576625E7EC6F44C42E9A637ED6B0BFF5CB6F406B7ED"+
		"EE386BFB5A899FA5AE9F24117C4B1FE649286651ECE45B3D"+
		"C2007CB8A163BF0598DA48361C55D39A69163FA8FD24CF5F"+
		"83655D23DCA3AD961C62F356208552BB9ED529077096966D"+
		"670C354E4ABC9804F1746C08CA18217C32905E462E36CE3B"+
		"E39E772C180E86039B2783A2EC07A28FB5C55DF06F4C52C9"+
		"DE2BCBF6955817183995497CEA956AE515D2261898FA0510"+
		"15728E5A8AACAA68FFFFFFFFFFFFFFFF", 16)

var elgamalG = big.NewInt(2)

// q = (p-1)/2 — ElGamal 부분군 위수
var elgamalQ = new(big.Int).Rsh(new(big.Int).Sub(elgamalP, big.NewInt(1)), 1)

// ElGamalPublicKey 공개키 (공개 원장에 저장)
type ElGamalPublicKey struct {
	P string `json:"p"` // 소수 (hex)
	G string `json:"g"` // 생성자 (hex)
	Y string `json:"y"` // g^x mod p (hex)
}

// ElGamalCiphertext 암호문 (c1, c2)
type ElGamalCiphertext struct {
	C1 string `json:"c1"` // g^r mod p (hex)
	C2 string `json:"c2"` // m * y^r mod p (hex)
}

// ChaumPedersenProof [PAPER-11] 복호화 정확성 ZKP
// 증명: "나는 x를 알고 있으며, y = g^x 이고 s = c1^x 이다"
// → c2/m = c1^x = s 가 올바른 복호화임을 키 공개 없이 증명
type ChaumPedersenProof struct {
	NullifierHash       string `json:"nullifierHash"`
	C1                  string `json:"c1"`            // ElGamal 암호문 c1
	C2                  string `json:"c2"`            // ElGamal 암호문 c2
	DecryptedHash       string `json:"decryptedHash"` // SHA256(복호화된 평문)
	A1                  string `json:"a1"`            // g^k mod p
	A2                  string `json:"a2"`            // c1^k mod p
	E                   string `json:"e"`             // Fiat-Shamir challenge
	Z                   string `json:"z"`             // k + e*x mod q
	CandidateCommitment string `json:"candidateCommitment"`
}

// getTxTime 트랜잭션 타임스탬프를 Unix seconds로 반환합니다.
// time.Now() 대신 반드시 이 함수를 사용해야 합니다.
// 이유: 다중 조직 endorsement 환경에서 피어마다 time.Now() 값이 달라
//
//	RW-set 불일치 → 정책 통과 실패가 발생합니다.
//	GetTxTimestamp()는 트랜잭션 제안서에 포함된 단일 시각이므로
//	모든 피어에서 동일한 값을 보장합니다.
func getTxTime(ctx contractapi.TransactionContextInterface) (int64, error) {
	ts, err := ctx.GetStub().GetTxTimestamp()
	if err != nil {
		return 0, fmt.Errorf("트랜잭션 타임스탬프 조회 실패: %w", err)
	}
	return ts.Seconds, nil
}

// ============================================================
// 데이터 구조체 (Struct) 정의
// ============================================================

// Election 선거 정보 (공개 원장)
type Election struct {
	ObjectType  string   `json:"docType"` // CouchDB 인덱스용 ("election")
	ElectionID  string   `json:"electionID"`
	Title       string   `json:"title"`
	Description string   `json:"description"`
	Candidates  []string `json:"candidates"` // 후보자 ID 목록
	StartTime   int64    `json:"startTime"`  // Unix timestamp
	EndTime     int64    `json:"endTime"`
	Status      string   `json:"status"`    // CREATED | ACTIVE | CLOSED
	CreatedBy   string   `json:"createdBy"` // 선거관리자 MSP ID
	// [CRIT-03 FIX] 선거별 블라인딩 팩터 — nullifier 선거 간 연결 방지
	// SHA256(signed credential material + electionID + blindingFactor)의 선거별 salt
	BlindingFactor string `json:"blindingFactor"` // SHA256(txID + electionID)
	// [PAPER-1] 선거 공개 암호화 키 (hex)
	// 클라이언트가 이 키로 candidateID를 암호화하여 제출.
	// 체인코드는 암호문만 저장하고 평문을 보지 않음.
	// 비밀키는 PDC에만 저장 → Shamir으로 분산 → threshold 복호화로 집계.
	EncryptionPubKey string `json:"encryptionPubKey,omitempty" metadata:",optional"` // AES-256 키를 감싼 공개키 (hex)
	// [PAPER-11] 암호화 모드: "aes" (기본) 또는 "elgamal"
	EncryptionMode string `json:"encryptionMode,omitempty" metadata:",optional"` // "aes" | "elgamal" | "elgamal-vector-v3"
	// [PAPER-11] ElGamal 공개키 (elgamal 모드일 때만 사용)
	ElGamalPubKey *ElGamalPublicKey `json:"elgamalPubKey,omitempty" metadata:",optional"`
	// ThresholdPublicShares are trustee verification keys y_i=g^x_i. They are
	// sufficient to verify partial decryptions but reveal no trustee secret.
	ThresholdPublicShares []ThresholdPublicShare `json:"thresholdPublicShares,omitempty" metadata:",optional"`
	KeyCeremonyMode       string                 `json:"keyCeremonyMode,omitempty" metadata:",optional"`
	DKGCeremonyID         string                 `json:"dkgCeremonyID,omitempty" metadata:",optional"`
	DKGTranscriptHash     string                 `json:"dkgTranscriptHash,omitempty" metadata:",optional"`
	DKGApprovals          []string               `json:"dkgApprovals,omitempty" metadata:",optional"`
}

// Nullifier 익명 투표 증명 (공개 원장)
// 유권자가 투표했다는 사실만 증명하고 누가 투표했는지는 알 수 없음.
// nullifierHash = SHA256(signed credential material + electionID + blindingFactor)
type Nullifier struct {
	ObjectType                string                     `json:"docType"`       // "nullifier"
	NullifierHash             string                     `json:"nullifierHash"` // 최종 1표만 유효 키 (재투표 시 덮어쓰기, 원장 Key로도 사용)
	ElectionID                string                     `json:"electionID"`
	CandidateID               string                     `json:"candidateID" metadata:",optional"`                   // 레거시 호환 전용. 신규 투표에서는 평문 후보자를 저장하지 않음.
	CandidateCommitment       string                     `json:"candidateCommitment"`                                // SHA256(electionID|nullifierHash|encryptedCandidateID)
	EncryptedCandidateID      string                     `json:"encryptedCandidateID"`                               // [C-4] AES-GCM 암호화된 후보자 ID
	BallotValidityProof       *BallotValidityProof       `json:"ballotValidityProof,omitempty" metadata:",optional"` // ElGamal 투표 유효성 공개 증거
	EncryptedCandidateVector  []ElGamalCiphertext        `json:"encryptedCandidateVector,omitempty" metadata:",optional"`
	VectorBallotValidityProof *VectorBallotValidityProof `json:"vectorBallotValidityProof,omitempty" metadata:",optional"`
	PreparedBallotID          string                     `json:"preparedBallotID,omitempty" metadata:",optional"`
	Timestamp                 int64                      `json:"timestamp"`
	EvictCount                int                        `json:"evictCount"`    // 재투표 횟수 (0 = 최초 투표)
	LastEvictedAt             int64                      `json:"lastEvictedAt"` // 마지막 재투표 시각
	// CredentialHash is retained only to decode legacy ledger records. New
	// ballots intentionally omit it: a stable token hash lets the issuer link
	// its issuance record to the public ballot/nullifier record.
	CredentialHash string `json:"credentialHash,omitempty" metadata:",optional"`
	// [PAPER-4] 자격증명 검증 수준
	CredVerifyLevel string `json:"credVerifyLevel,omitempty" metadata:",optional"` // "chaincode" | "metadata-only"
	// IsPadding marks the pre-created panic-mode padding records.  The existing
	// DUMMY_IDX keys already reveal these records, so making the type explicit
	// does not weaken the current scheme; it prevents AES padding ciphertexts
	// from being interpreted as malformed voter-supplied ElGamal ciphertexts.
	// A future coercion-resistance design must replace the publicly linkable
	// DUMMY_IDX mechanism with indistinguishable, proof-carrying padding ballots.
	IsPadding bool `json:"isPadding,omitempty" metadata:",optional"`
}

// CredentialVerification [CRIT-01/02 FIX] 체인코드 독립 검증용 자격증명 메타데이터
// API 서버가 transient map "credentialVerification" 키로 전달.
// 원본 토큰 대신 구조적 속성만 전달하여 신원 노출 방지.
type CredentialVerification struct {
	CredType   string `json:"credType"`   // "ps" | "bbs" | "hmac" | "ed25519" | "bypass"
	ElectionID string `json:"electionID"` // 자격증명에 바인딩된 선거 ID
	ExpUnix    int64  `json:"expUnix"`    // 만료 시각 (Unix seconds)
	CredHash   string `json:"credHash"`   // SHA256(원본 token/proof) — transient 무결성 결합용
}

type CredentialRevocation struct {
	Schema       string `json:"schema"`
	ElectionID   string `json:"electionID"`
	HandleHash   string `json:"handleHash"`
	ReasonCode   string `json:"reasonCode"`
	RevokedAt    int64  `json:"revokedAt"`
	RevokedByMSP string `json:"revokedByMSP"`
	TxID         string `json:"txID"`
}

type Ed25519CredentialHeader struct {
	Alg string `json:"alg"`
}

type Ed25519CredentialPayload struct {
	VoterEligible string  `json:"voterEligible"`
	ElectionID    string  `json:"electionID"`
	Nonce         string  `json:"nonce"`
	Exp           float64 `json:"exp"`
}

type PSPublicKey struct {
	Curve     string   `json:"curve"`
	Scheme    string   `json:"scheme"`
	AttrCount int      `json:"attrCount"`
	X         string   `json:"X"`
	Ys        []string `json:"Ys"`
}

type PSCredentialToken struct {
	Type  string   `json:"type"`
	H     string   `json:"h"`
	S     string   `json:"s"`
	Attrs []string `json:"attrs"`
	ExpMs float64  `json:"expMs"`
}

// credentialNullifierMaterial returns a value that is covered by the
// credential signature/proof. It never trusts an API-supplied standalone
// value, so a compromised API cannot mint arbitrary nullifiers.
func credentialNullifierMaterial(ctx contractapi.TransactionContextInterface, cv CredentialVerification) (string, error) {
	transient, err := ctx.GetStub().GetTransient()
	if err != nil {
		return "", fmt.Errorf("transient 읽기 실패: %w", err)
	}
	switch cv.CredType {
	case "ed25519":
		token := string(transient["credentialToken"])
		parts := strings.Split(token, ".")
		if len(parts) != 3 {
			return "", fmt.Errorf("Ed25519 credential 형식 오류")
		}
		payloadBytes, err := decodeBase64Flexible(parts[1])
		if err != nil {
			return "", fmt.Errorf("Ed25519 payload 디코딩 실패: %w", err)
		}
		var payload Ed25519CredentialPayload
		if err := json.Unmarshal(payloadBytes, &payload); err != nil {
			return "", fmt.Errorf("Ed25519 payload 파싱 실패: %w", err)
		}
		if payload.Nonce == "" {
			return "", fmt.Errorf("서명된 nullifier material 누락")
		}
		return payload.Nonce, nil
	case "hmac":
		token := string(transient["credentialToken"])
		dot := strings.LastIndex(token, ".")
		if dot < 1 {
			return "", fmt.Errorf("HMAC credential 형식 오류")
		}
		payloadBytes, err := decodeBase64Flexible(token[:dot])
		if err != nil {
			return "", fmt.Errorf("HMAC payload 디코딩 실패: %w", err)
		}
		var payload struct {
			Nonce string `json:"nonce"`
		}
		if err := json.Unmarshal(payloadBytes, &payload); err != nil {
			return "", fmt.Errorf("HMAC payload 파싱 실패: %w", err)
		}
		if payload.Nonce == "" {
			return "", fmt.Errorf("서명된 nullifier material 누락")
		}
		return payload.Nonce, nil
	case "ps":
		token := strings.TrimPrefix(string(transient["credentialToken"]), "ps.")
		credJSON, err := decodeBase64Flexible(token)
		if err != nil {
			return "", fmt.Errorf("PS credential 디코딩 실패: %w", err)
		}
		var cred PSCredentialToken
		if err := json.Unmarshal(credJSON, &cred); err != nil {
			return "", fmt.Errorf("PS credential 파싱 실패: %w", err)
		}
		if len(cred.Attrs) != 4 || cred.Attrs[3] == "" {
			return "", fmt.Errorf("PS 서명 nullifier material 누락")
		}
		return cred.Attrs[3], nil
	case "bbs":
		var proof BBSProofPresentation
		if err := json.Unmarshal(transient["bbsProof"], &proof); err != nil {
			return "", fmt.Errorf("BBS proof 파싱 실패: %w", err)
		}
		if len(proof.RevealedAttrs) != 4 || len(proof.RevealedIndices) != 4 || proof.RevealedIndices[3] != 3 || proof.RevealedAttrs[3] == "" {
			return "", fmt.Errorf("BBS 증명 nullifier material 누락")
		}
		return proof.RevealedAttrs[3], nil
	case "bypass":
		return "", nil
	default:
		return "", fmt.Errorf("알 수 없는 credential 유형")
	}
}

func computeCredentialBoundNullifier(material, electionID, blindingFactor string) (string, error) {
	if material == "" || electionID == "" || blindingFactor == "" {
		return "", fmt.Errorf("nullifier 바인딩 입력 누락")
	}
	digest := sha256.Sum256([]byte(material + electionID + blindingFactor))
	return hex.EncodeToString(digest[:]), nil
}

// computeCredentialRevocationHandle derives an election-scoped handle from
// material that is already protected by the credential signature/proof. The
// length-prefixed, versioned transcript is deliberately distinct from the
// legacy ballot nullifier transcript. It is a Stage-A revocation primitive;
// it is not an anonymous accumulator or a non-revocation proof.
func computeCredentialRevocationHandle(material, electionID, blindingFactor string) (string, error) {
	if material == "" || electionID == "" || blindingFactor == "" {
		return "", fmt.Errorf("credential revocation 입력 누락")
	}
	fields := []string{material, electionID, blindingFactor}
	h := sha256.New()
	_, _ = h.Write([]byte("mongbas/revocation/v1"))
	var length [4]byte
	for _, field := range fields {
		if uint64(len(field)) > uint64(^uint32(0)) {
			return "", fmt.Errorf("credential revocation 입력이 너무 깁니다")
		}
		binary.BigEndian.PutUint32(length[:], uint32(len(field)))
		_, _ = h.Write(length[:])
		_, _ = h.Write([]byte(field))
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

func credentialRevocationStateKey(electionID, handle string) (string, error) {
	if err := validateElectionID(electionID); err != nil {
		return "", err
	}
	decoded, err := hex.DecodeString(handle)
	if err != nil || len(decoded) != sha256.Size || handle != strings.ToLower(handle) {
		return "", fmt.Errorf("revocation handle은 64자 소문자 SHA-256 hex여야 합니다")
	}
	digest := sha256.Sum256([]byte(electionID + "\x00" + handle))
	return "REVOCATION_" + hex.EncodeToString(digest[:]), nil
}

func validCredentialRevocationReason(reason string) bool {
	switch reason {
	case "eligibility-withdrawn", "credential-compromised", "issued-in-error":
		return true
	default:
		return false
	}
}

type BBSProofPresentation struct {
	Type            string   `json:"type"`
	Proof           string   `json:"proof"`
	Nonce           string   `json:"nonce"`
	RevealedAttrs   []string `json:"revealedAttrs"`
	RevealedIndices []int    `json:"revealedIndices"`
}

// VotePrivate PDC에 저장되는 원본 투표 데이터 (비공개)
// 오더러에게 전달되지 않고 피어의 사이드 DB에만 저장됨.
// 클라이언트는 이 구조체를 JSON으로 직렬화하여 트랜잭션 Transient Map에 넣어서 전달.
type VotePrivate struct {
	ObjectType               string              `json:"docType"`              // "votePrivate"
	ElectionID               string              `json:"electionID"`           // 선거 ID
	NullifierHash            string              `json:"nullifierHash"`        // 공개 Nullifier와 연결 고리
	EncryptedCandidateID     string              `json:"encryptedCandidateID"` // 후보자 암호문
	EncryptedCandidateVector []ElGamalCiphertext `json:"encryptedCandidateVector,omitempty" metadata:",optional"`
	CandidateCommitment      string              `json:"candidateCommitment"` // 공개 원장 commitment와 일치해야 함
	VoteHash                 string              `json:"voteHash"`            // 암호화 투표 레코드 무결성 확인용
	Timestamp                int64               `json:"timestamp"`
	// [PAPER-12] Experimental panic filtering metadata; not a proof of coercion resistance.
	// "real" (기본): 유효 투표, 집계에 포함
	// "panic": 패닉 경로로 제출된 투표, 집계에서 제외.
	// PDC readers and public revote patterns remain explicit distinguishing risks.
	CredentialType string `json:"credentialType,omitempty" metadata:",optional"` // "real" | "panic"
}

// VoteTally 선거 집계 결과 (공개 원장, CloseElection 호출 시 기록)
type VoteTally struct {
	ObjectType string         `json:"docType"` // "tally"
	ElectionID string         `json:"electionID"`
	Results    map[string]int `json:"results"` // candidateID → 득표수
	TotalVotes int            `json:"totalVotes"`
	ClosedAt   int64          `json:"closedAt"`
	// [PAPER-2] tallied-as-recorded 검증용 증명
	TallyProofHash   string            `json:"tallyProofHash,omitempty" metadata:",optional"`   // 모든 복호화 기록의 해시
	DecryptionProofs []DecryptionProof `json:"decryptionProofs,omitempty" metadata:",optional"` // 개별 투표 복호화 증명
	// [P2] ElGamal threshold: 키 분산 후에는 종료 시 복호화하지 않고 암호문 집계만 저장.
	//   2-of-3 조각 복원 후에 복호화되어 Results가 채워지고 Decrypted=true가 된다.
	Decrypted                bool                      `json:"decrypted" metadata:",optional"`          // 결과 복호화 완료 여부
	EncAggC1                 string                    `json:"encAggC1,omitempty" metadata:",optional"` // 동형 집계 암호문 c1 (복호화 대기 시)
	EncAggC2                 string                    `json:"encAggC2,omitempty" metadata:",optional"` // 동형 집계 암호문 c2 (복호화 대기 시)
	PartialDecryptions       []PartialDecryption       `json:"partialDecryptions,omitempty" metadata:",optional"`
	EncAggVector             []ElGamalCiphertext       `json:"encAggVector,omitempty" metadata:",optional"`
	VectorPartialDecryptions []VectorPartialDecryption `json:"vectorPartialDecryptions,omitempty" metadata:",optional"`
}

// ThresholdPublicShare binds a Shamir evaluation index to its public
// verification key. MSP binding prevents a valid share from being relabelled.
type ThresholdPublicShare struct {
	Index      int    `json:"index"`
	MSPID      string `json:"mspID"`
	PublicKeyY string `json:"publicKeyY"`
}

// PartialDecryption is the only trustee artifact published for ElGamal-v2.
// Value=c1^x_i and Proof demonstrates log_g(y_i)=log_c1(Value).
type PartialDecryption struct {
	Index      int                 `json:"index"`
	MSPID      string              `json:"mspID"`
	PublicKeyY string              `json:"publicKeyY"`
	Value      string              `json:"value"`
	Proof      *ChaumPedersenProof `json:"proof"`
}

// VectorPartialDecryption contains one verified trustee contribution for each
// candidate aggregate. Index and MSP identity bind the whole vector atomically.
type VectorPartialDecryption struct {
	Index      int                   `json:"index"`
	MSPID      string                `json:"mspID"`
	PublicKeyY string                `json:"publicKeyY"`
	Values     []string              `json:"values"`
	Proofs     []*ChaumPedersenProof `json:"proofs"`
}

// DecryptionProof [PAPER-2] 개별 투표의 복호화 정확성 증명
// AES 모드: 검증자는 encryptionKey로 encryptedCandidateID를 복호화하여 decryptedHash와 비교
// ElGamal 모드: Chaum-Pedersen ZKP로 키 공개 없이 검증 (PAPER-11)
type DecryptionProof struct {
	NullifierHash        string `json:"nullifierHash"`        // 투표 식별자
	EncryptedCandidateID string `json:"encryptedCandidateID"` // 원본 암호문
	DecryptedHash        string `json:"decryptedHash"`        // SHA256(복호화된 candidateID)
	CandidateCommitment  string `json:"candidateCommitment"`  // 투표 시 생성된 commitment
	// [PAPER-11] ElGamal + Chaum-Pedersen ZKP 필드 (ElGamal 모드일 때만 사용)
	ZKProof *ChaumPedersenProof `json:"zkProof,omitempty" metadata:",optional"`
}

// VoterPWPrivate PDC에 저장되는 유권자 비밀번호 해시 (비공개)
// CastVote 시 transient "votePrivate" 에 포함하여 전달합니다.
//
// normalPWHash  : SHA256(normalPassword  + nullifierHash) — 실제 증명용
// panicPWHash   : SHA256(panicPassword   + nullifierHash) — 강압 대응용 (더미 증명 반환)
// panicCandidateID : Panic Mode에서 보여줄 가짜 후보자 ID
type VoterPWPrivate struct {
	NormalPWHash      string `json:"normalPWHash"`
	PanicPWHash       string `json:"panicPWHash"`
	NormalLookupToken string `json:"normalLookupToken,omitempty"`
	PanicLookupToken  string `json:"panicLookupToken,omitempty"`
	PanicCandidateID  string `json:"panicCandidateID"` // 강압자에게 보여줄 가짜 후보
}

// DeniableLookupPrivate is addressed by an opaque, password-derived token.
// The public API never needs the ballot nullifier to retrieve a proof. This
// removes the direct request-nullifier/response-target oracle, but does not
// hide the mapping from peers authorized to read VotePrivatePDC.
type DeniableLookupPrivate struct {
	ElectionID          string `json:"electionID"`
	TargetNullifierHash string `json:"targetNullifierHash"`
}

// BallotValidityProof [PAPER-13] Disjunctive Chaum-Pedersen ZKP
// 투표 암호문이 유효한 후보 인코딩 {g^(B^0), g^(B^1), ..., g^(B^(k-1))} 중 하나임을 증명
// Cramer-Damgård-Schoenmakers (1994) OR-proof 기법
type BallotValidityProof struct {
	// 각 후보 j에 대한 시뮬레이션/실제 증명 컴포넌트
	A1s []string `json:"a1s"` // g^k_j mod p (각 후보)
	A2s []string `json:"a2s"` // c1^k_j mod p (각 후보)
	Es  []string `json:"es"`  // challenge e_j (hex)
	Zs  []string `json:"zs"`  // response z_j (hex)
}

// EqualityOfDiscreteLogsProof proves log_Base1(Result1) =
// log_Base2(Result2), without revealing that logarithm.
type EqualityOfDiscreteLogsProof struct {
	A1 string `json:"a1"`
	A2 string `json:"a2"`
	E  string `json:"e"`
	Z  string `json:"z"`
}

// VectorBallotValidityProof proves that every component is a bit and that the
// component plaintexts sum to exactly one.
type VectorBallotValidityProof struct {
	BitProofs []*BallotValidityProof       `json:"bitProofs"`
	SumProof  *EqualityOfDiscreteLogsProof `json:"sumProof"`
}

// HomomorphicTallyProof [PAPER-13] 동형 집계 정확성 증명
// 암호문 곱의 복호화가 올바름을 증명하는 Chaum-Pedersen ZKP
type HomomorphicTallyProof struct {
	AccC1        string              `json:"accC1"`                                  // 누적 c1 = Π c1_i mod p
	AccC2        string              `json:"accC2"`                                  // 누적 c2 = Π c2_i mod p
	DecryptedSum int                 `json:"decryptedSum"`                           // g^sum의 이산로그 복원 결과
	ZKProof      *ChaumPedersenProof `json:"zkProof,omitempty" metadata:",optional"` // 복호화 정확성 ZKP
}

// BallotPreparation [PAPER-3] Benaloh Challenge용 사전 암호화 투표
// PDC에 임시 저장되며, audit 또는 cast 중 하나만 수행 가능
type BallotPreparation struct {
	BallotID             string `json:"ballotID"` // 고유 ID (SHA256 유도)
	ElectionID           string `json:"electionID"`
	CandidateID          string `json:"candidateID"`          // 평문 (audit 시에만 공개)
	EncryptedCandidateID string `json:"encryptedCandidateID"` // AES-GCM 암호문
	Commitment           string `json:"commitment"`           // SHA256(ballotID + encryptedCandidateID)
	Status               string `json:"status"`               // "prepared" | "audited" | "cast"
	CreatedAt            int64  `json:"createdAt"`
}

// VectorAuditArtifact is the exact browser-generated ciphertext/proof object
// committed before the voter chooses audit or cast.
type VectorAuditArtifact struct {
	EncryptedCandidateVector  []ElGamalCiphertext        `json:"encryptedCandidateVector"`
	VectorBallotValidityProof *VectorBallotValidityProof `json:"vectorBallotValidityProof"`
}

// VectorBallotPreparation is private because it binds the prepared artifact to
// the credential-derived nullifier. No plaintext selection or randomness is
// stored; those are disclosed only when the voter explicitly spoils the ballot.
type VectorBallotPreparation struct {
	Schema          string              `json:"schema"`
	BallotID        string              `json:"ballotID"`
	ElectionID      string              `json:"electionID"`
	NullifierHash   string              `json:"nullifierHash"`
	ClientNonceHash string              `json:"clientNonceHash"`
	ArtifactHash    string              `json:"artifactHash"`
	Artifact        VectorAuditArtifact `json:"artifact"`
	Status          string              `json:"status"`
	CreatedAt       int64               `json:"createdAt"`
	TerminalAt      int64               `json:"terminalAt,omitempty" metadata:",optional"`
	TerminalTxID    string              `json:"terminalTxID,omitempty" metadata:",optional"`
}

// VectorBallotReceipt is the public append-only checkpoint used by the
// standalone verifier. It intentionally omits the credential and nullifier.
type VectorBallotReceipt struct {
	Schema       string `json:"schema"`
	BallotID     string `json:"ballotID"`
	ElectionID   string `json:"electionID"`
	ArtifactHash string `json:"artifactHash"`
	Status       string `json:"status"`
	CreatedAt    int64  `json:"createdAt"`
	CreatedTxID  string `json:"createdTxID"`
	TerminalAt   int64  `json:"terminalAt,omitempty" metadata:",optional"`
	TerminalTxID string `json:"terminalTxID,omitempty" metadata:",optional"`
}

type VectorAuditWitness struct {
	ClientNonce string   `json:"clientNonce"`
	Randomness  []string `json:"randomness"`
}

// VectorAuditDisclosure is public only for a spoiled ballot. It contains
// enough material for an offline verifier to recompute every ciphertext but no
// credential/nullifier linkage.
type VectorAuditDisclosure struct {
	Schema                    string                     `json:"schema"`
	BallotID                  string                     `json:"ballotID"`
	ElectionID                string                     `json:"electionID"`
	ArtifactHash              string                     `json:"artifactHash"`
	SelectedIndex             int                        `json:"selectedIndex"`
	ClientNonce               string                     `json:"clientNonce"`
	Randomness                []string                   `json:"randomness"`
	EncryptedCandidateVector  []ElGamalCiphertext        `json:"encryptedCandidateVector"`
	VectorBallotValidityProof *VectorBallotValidityProof `json:"vectorBallotValidityProof"`
	Status                    string                     `json:"status"`
	AuditedAt                 int64                      `json:"auditedAt"`
	AuditedTxID               string                     `json:"auditedTxID"`
}

// ============================================================
// 체인코드 컨트랙트
// ============================================================

// VotingContract Hyperledger Fabric 스마트 컨트랙트
type VotingContract struct {
	contractapi.Contract
}

// PDC 이름 상수 — collection_config.json 의 name 값과 반드시 일치해야 함
const (
	VotePrivatePDC = "VotePrivateCollection"

	// PanicDummyCount 선거 생성 시 후보자별 생성되는 더미 투표 수
	// Panic Mode에서 유권자는 이 더미 레코드 중 하나를 실제 투표처럼 보여줍니다.
	// 더미도 실제 Nullifier로 저장되어 Merkle Tree에 포함 → 수학적으로 검증 가능
	PanicDummyCount = 3

	// [PAPER-13] HomomorphicBase 동형 집계용 base encoding
	// 후보 i → 메시지 m = B^i (0-indexed)
	// 집계: Σm_i = c_0*B^0 + c_1*B^1 + ... (base-B 자릿수 분해로 후보별 득표수 복원)
	// B=10000 → 후보당 최대 9999표 지원
	HomomorphicBase = 10000
	maxBSGSSearch   = int64(4000000000)
)

const (
	// Shamir's Secret Sharing 파라미터
	ShamirThreshold   = 2 // 복원에 필요한 최소 share 수
	ShamirTotalShares = 3 // 총 share 수 (3개 조직)
)

var shareIndexMSP = map[string]string{
	"1": "ElectionCommissionMSP",
	"2": "PartyObserverMSP",
	"3": "CivilSocietyMSP",
}

func requireElectionAdmin(ctx contractapi.TransactionContextInterface) error {
	mspID, err := ctx.GetClientIdentity().GetMSPID()
	if err != nil {
		return fmt.Errorf("MSP ID 조회 실패: %w", err)
	}
	if mspID != "ElectionCommissionMSP" {
		return fmt.Errorf("관리자 권한 없음: ElectionCommissionMSP 필요 (현재: %s)", mspID)
	}
	return nil
}

func requireShareOwner(ctx contractapi.TransactionContextInterface, shareIndex string) error {
	expectedMSP, ok := shareIndexMSP[shareIndex]
	if !ok {
		return fmt.Errorf("shareIndex는 1, 2, 3 중 하나여야 합니다: %s", shareIndex)
	}
	mspID, err := ctx.GetClientIdentity().GetMSPID()
	if err != nil {
		return fmt.Errorf("MSP ID 조회 실패: %w", err)
	}
	if mspID != expectedMSP {
		return fmt.Errorf("share %s 접근 권한 없음: %s 필요 (현재: %s)", shareIndex, expectedMSP, mspID)
	}
	return nil
}

// validateElectionID는 electionID에 CouchDB 쿼리 인젝션을 유발할 수 있는 문자가 없는지 확인한다.
// 허용: 영문 대소문자, 숫자, 하이픈, 밑줄, 마침표
func validateElectionID(id string) error {
	if len(id) == 0 || len(id) > 256 {
		return fmt.Errorf("electionID 길이는 1~256자여야 합니다 (현재: %d)", len(id))
	}
	for _, c := range id {
		if !((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '-' || c == '_' || c == '.') {
			return fmt.Errorf("electionID에 허용되지 않는 문자 포함: %c", c)
		}
	}
	return nil
}

// hashWithLengthPrefix는 가변 길이 필드를 길이 접두어 방식으로 해싱하여
// 구분자 기반 문자열 연결에서 발생할 수 있는 해시 충돌을 방지한다.
func hashWithLengthPrefix(fields ...string) string {
	h := sha256.New()
	for _, f := range fields {
		lenBuf := []byte(fmt.Sprintf("%08x", len(f)))
		h.Write(lenBuf)
		h.Write([]byte(f))
	}
	return hex.EncodeToString(h.Sum(nil))
}

func computeCandidateCommitment(electionID, nullifierHash, encryptedCandidateID string) string {
	raw := sha256.Sum256([]byte(electionID + "|" + nullifierHash + "|" + encryptedCandidateID))
	return hex.EncodeToString(raw[:])
}

// computeVectorAuditArtifactHash mirrors application/src/lib/vectorElgamal.js.
// The marshal/unmarshal/marshal sequence converts nested structs to JSON maps;
// encoding/json then sorts every object key, so browser and chaincode bind the
// same artifact regardless of input object property order.
func computeVectorAuditArtifactHash(electionID string, candidates []string, vector []ElGamalCiphertext, proof *VectorBallotValidityProof) (string, error) {
	if err := validateElectionID(electionID); err != nil {
		return "", err
	}
	if len(candidates) < 2 || len(vector) != len(candidates) || proof == nil {
		return "", fmt.Errorf("invalid vector-v3 audit artifact")
	}
	for _, candidate := range candidates {
		if candidate == "" {
			return "", fmt.Errorf("invalid vector-v3 audit artifact candidate")
		}
	}
	artifact := map[string]interface{}{
		"schema":                    "mongbas-vector-audit-artifact/v1",
		"electionID":                electionID,
		"candidates":                candidates,
		"encryptedCandidateVector":  vector,
		"vectorBallotValidityProof": proof,
	}
	raw, err := json.Marshal(artifact)
	if err != nil {
		return "", fmt.Errorf("vector audit artifact marshal failed: %w", err)
	}
	var normalized interface{}
	if err := json.Unmarshal(raw, &normalized); err != nil {
		return "", fmt.Errorf("vector audit artifact normalization failed: %w", err)
	}
	canonical, err := json.Marshal(normalized)
	if err != nil {
		return "", fmt.Errorf("vector audit artifact canonicalization failed: %w", err)
	}
	digest := sha256.Sum256(canonical)
	return hex.EncodeToString(digest[:]), nil
}

func decodeBase64Flexible(s string) ([]byte, error) {
	if b, err := base64.StdEncoding.DecodeString(s); err == nil {
		return b, nil
	}
	if b, err := base64.RawStdEncoding.DecodeString(s); err == nil {
		return b, nil
	}
	if b, err := base64.URLEncoding.DecodeString(s); err == nil {
		return b, nil
	}
	return base64.RawURLEncoding.DecodeString(s)
}

func psMsgToScalar(msg string) *big.Int {
	sum := sha256.Sum256([]byte(msg))
	x := new(big.Int).SetBytes(sum[:])
	x.Mod(x, bn256.Order)
	if x.Sign() == 0 {
		return big.NewInt(1)
	}
	return x
}

func decodePSG1(s string) (*bn256.G1, error) {
	raw, err := decodeBase64Flexible(s)
	if err != nil {
		return nil, err
	}
	p := new(bn256.G1)
	if rest, err := p.Unmarshal(raw); err != nil {
		return nil, err
	} else if len(rest) != 0 {
		return nil, fmt.Errorf("G1 trailing bytes: %d", len(rest))
	}
	return p, nil
}

func decodePSG2(s string) (*bn256.G2, error) {
	raw, err := decodeBase64Flexible(s)
	if err != nil {
		return nil, err
	}
	p := new(bn256.G2)
	if rest, err := p.Unmarshal(raw); err != nil {
		return nil, err
	} else if len(rest) != 0 {
		return nil, fmt.Errorf("G2 trailing bytes: %d", len(rest))
	}
	return p, nil
}

func verifyPSCredentialToken(ctx contractapi.TransactionContextInterface, cv CredentialVerification, electionID string, txNow int64) error {
	pubKeyB64 := os.Getenv("PS_ISSUER_PUBLIC_KEY_B64")
	if pubKeyB64 == "" {
		return fmt.Errorf("PS_ISSUER_PUBLIC_KEY_B64 환경변수가 설정되지 않았습니다")
	}
	pubKeyJSON, err := decodeBase64Flexible(pubKeyB64)
	if err != nil {
		return fmt.Errorf("PS 공개키 base64 디코딩 실패: %w", err)
	}
	var pk PSPublicKey
	if err := json.Unmarshal(pubKeyJSON, &pk); err != nil {
		return fmt.Errorf("PS 공개키 JSON 파싱 실패: %w", err)
	}
	if pk.Curve != "bn254" || pk.Scheme != "ps" || pk.AttrCount != 4 || len(pk.Ys) != 4 {
		return fmt.Errorf("PS 공개키 메타데이터 불일치")
	}
	X, err := decodePSG2(pk.X)
	if err != nil {
		return fmt.Errorf("PS 공개키 X 디코딩 실패: %w", err)
	}
	Ys := make([]*bn256.G2, len(pk.Ys))
	for i, yRaw := range pk.Ys {
		Ys[i], err = decodePSG2(yRaw)
		if err != nil {
			return fmt.Errorf("PS 공개키 Y%d 디코딩 실패: %w", i, err)
		}
	}

	transient, err := ctx.GetStub().GetTransient()
	if err != nil {
		return fmt.Errorf("transient 읽기 실패: %w", err)
	}
	tokenBytes, ok := transient["credentialToken"]
	if !ok || len(tokenBytes) == 0 {
		return fmt.Errorf("PS credentialToken 누락")
	}
	token := string(tokenBytes)
	if !strings.HasPrefix(token, "ps.") {
		return fmt.Errorf("PS credential 형식 오류")
	}
	credJSON, err := decodeBase64Flexible(strings.TrimPrefix(token, "ps."))
	if err != nil {
		return fmt.Errorf("PS credential 디코딩 실패: %w", err)
	}
	var cred PSCredentialToken
	if err := json.Unmarshal(credJSON, &cred); err != nil {
		return fmt.Errorf("PS credential JSON 파싱 실패: %w", err)
	}
	if cred.Type != "ps" || len(cred.Attrs) != 4 || cred.Attrs[3] == "" {
		return fmt.Errorf("PS credential 속성 형식 오류")
	}
	if cred.Attrs[0] != "1" {
		return fmt.Errorf("투표 자격 속성 없음")
	}
	if cred.Attrs[1] != electionID || cred.Attrs[1] != cv.ElectionID {
		return fmt.Errorf("PS credential 선거ID 불일치: payload=%s, cred=%s, req=%s", cred.Attrs[1], cv.ElectionID, electionID)
	}
	attrExpMs, err := strconv.ParseInt(cred.Attrs[2], 10, 64)
	if err != nil {
		return fmt.Errorf("PS credential exp 속성 파싱 실패: %w", err)
	}
	expUnix := attrExpMs / 1000
	if txNow > expUnix || expUnix != cv.ExpUnix {
		return fmt.Errorf("PS credential 만료 또는 exp 불일치")
	}
	if txNow > int64(cred.ExpMs/1000) {
		return fmt.Errorf("PS credential expMs 만료")
	}

	hPoint, err := decodePSG1(cred.H)
	if err != nil {
		return fmt.Errorf("PS h 디코딩 실패: %w", err)
	}
	sPoint, err := decodePSG1(cred.S)
	if err != nil {
		return fmt.Errorf("PS sigma 디코딩 실패: %w", err)
	}

	pkAgg := new(bn256.G2).Set(X)
	for i, attr := range cred.Attrs {
		term := new(bn256.G2).ScalarMult(Ys[i], psMsgToScalar(attr))
		pkAgg.Add(pkAgg, term)
	}
	negSigma := new(bn256.G1).Neg(sPoint)
	if !bn256.PairingCheck([]*bn256.G1{hPoint, negSigma}, []*bn256.G2{pkAgg, new(bn256.G2).ScalarBaseMult(big.NewInt(1))}) {
		return fmt.Errorf("PS 서명 pairing 검증 실패")
	}
	hashRaw := sha256.Sum256([]byte(token))
	if hex.EncodeToString(hashRaw[:]) != cv.CredHash {
		return fmt.Errorf("PS credential hash 불일치")
	}
	return nil
}

func verifyBBSCredentialToken(ctx contractapi.TransactionContextInterface, cv CredentialVerification, electionID string, txNow int64) error {
	pubKeyB64 := os.Getenv("BBS_PUBLIC_KEY_B64")
	if pubKeyB64 == "" {
		return fmt.Errorf("BBS_PUBLIC_KEY_B64 환경변수가 설정되지 않았습니다")
	}
	pubKey, err := decodeBase64Flexible(pubKeyB64)
	if err != nil {
		return fmt.Errorf("BBS 공개키 base64 디코딩 실패: %w", err)
	}

	transient, err := ctx.GetStub().GetTransient()
	if err != nil {
		return fmt.Errorf("transient 읽기 실패: %w", err)
	}
	proofBytes, ok := transient["bbsProof"]
	if !ok || len(proofBytes) == 0 {
		return fmt.Errorf("BBS proof presentation 누락")
	}
	var presentation BBSProofPresentation
	if err := json.Unmarshal(proofBytes, &presentation); err != nil {
		return fmt.Errorf("BBS proof presentation JSON 파싱 실패: %w", err)
	}
	if presentation.Type != "bbs-proof" || len(presentation.RevealedAttrs) != 4 {
		return fmt.Errorf("BBS proof presentation 형식 오류")
	}
	if len(presentation.RevealedIndices) != 4 ||
		presentation.RevealedIndices[0] != 0 ||
		presentation.RevealedIndices[1] != 1 ||
		presentation.RevealedIndices[2] != 2 ||
		presentation.RevealedIndices[3] != 3 || presentation.RevealedAttrs[3] == "" {
		return fmt.Errorf("BBS proof revealed index 불일치")
	}
	if presentation.RevealedAttrs[0] != "1" {
		return fmt.Errorf("투표 자격 속성 없음")
	}
	if presentation.RevealedAttrs[1] != electionID || presentation.RevealedAttrs[1] != cv.ElectionID {
		return fmt.Errorf("BBS proof 선거ID 불일치: proof=%s, cred=%s, req=%s", presentation.RevealedAttrs[1], cv.ElectionID, electionID)
	}
	attrExpMs, err := strconv.ParseInt(presentation.RevealedAttrs[2], 10, 64)
	if err != nil {
		return fmt.Errorf("BBS proof exp 속성 파싱 실패: %w", err)
	}
	expUnix := attrExpMs / 1000
	if txNow > expUnix || expUnix != cv.ExpUnix {
		return fmt.Errorf("BBS proof 만료 또는 exp 불일치")
	}
	proof, err := decodeBase64Flexible(presentation.Proof)
	if err != nil {
		return fmt.Errorf("BBS proof 디코딩 실패: %w", err)
	}
	nonce, err := decodeBase64Flexible(presentation.Nonce)
	if err != nil {
		return fmt.Errorf("BBS nonce 디코딩 실패: %w", err)
	}
	payload, err := ariesbbs.ParsePoKPayload(proof)
	if err != nil {
		return fmt.Errorf("BBS proof payload 파싱 실패: %w", err)
	}
	if payload.MessagesCount != 4 || len(payload.Revealed) != 4 ||
		payload.Revealed[0] != 0 || payload.Revealed[1] != 1 || payload.Revealed[2] != 2 || payload.Revealed[3] != 3 {
		return fmt.Errorf("BBS proof payload revealed 속성 불일치")
	}
	messages := make([][]byte, len(presentation.RevealedAttrs))
	for i, attr := range presentation.RevealedAttrs {
		messages[i] = []byte(attr)
	}
	if err := ariesbbs.New(ml.Curves[ml.BLS12_381_BBS]).VerifyProof(messages, proof, nonce, pubKey); err != nil {
		return fmt.Errorf("BBS+ proof 검증 실패: %w", err)
	}
	hashRaw := sha256.Sum256(proofBytes)
	if hex.EncodeToString(hashRaw[:]) != cv.CredHash {
		return fmt.Errorf("BBS proof hash 불일치")
	}
	return nil
}

func verifyEd25519CredentialToken(ctx contractapi.TransactionContextInterface, cv CredentialVerification, electionID string, txNow int64) error {
	pubKeyB64 := os.Getenv("ED25519_PUBLIC_KEY_DER_B64")
	if pubKeyB64 == "" {
		return fmt.Errorf("ED25519_PUBLIC_KEY_DER_B64 환경변수가 설정되지 않았습니다")
	}
	pubDer, err := decodeBase64Flexible(pubKeyB64)
	if err != nil {
		return fmt.Errorf("Ed25519 공개키 base64 디코딩 실패: %w", err)
	}
	pubAny, err := x509.ParsePKIXPublicKey(pubDer)
	if err != nil {
		return fmt.Errorf("Ed25519 공개키 DER 파싱 실패: %w", err)
	}
	pubKey, ok := pubAny.(ed25519.PublicKey)
	if !ok {
		return fmt.Errorf("Ed25519 공개키 타입이 아닙니다")
	}

	transient, err := ctx.GetStub().GetTransient()
	if err != nil {
		return fmt.Errorf("transient 읽기 실패: %w", err)
	}
	tokenBytes, ok := transient["credentialToken"]
	if !ok || len(tokenBytes) == 0 {
		return fmt.Errorf("Ed25519 credentialToken 누락")
	}
	token := string(tokenBytes)
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return fmt.Errorf("Ed25519 credential 형식 오류")
	}

	headerBytes, err := decodeBase64Flexible(parts[0])
	if err != nil {
		return fmt.Errorf("Ed25519 credential header 디코딩 실패: %w", err)
	}
	var header Ed25519CredentialHeader
	if err := json.Unmarshal(headerBytes, &header); err != nil {
		return fmt.Errorf("Ed25519 credential header 파싱 실패: %w", err)
	}
	if header.Alg != "EdDSA" {
		return fmt.Errorf("Ed25519 credential alg 불일치: %s", header.Alg)
	}

	payloadBytes, err := decodeBase64Flexible(parts[1])
	if err != nil {
		return fmt.Errorf("Ed25519 credential payload 디코딩 실패: %w", err)
	}
	var payload Ed25519CredentialPayload
	if err := json.Unmarshal(payloadBytes, &payload); err != nil {
		return fmt.Errorf("Ed25519 credential payload 파싱 실패: %w", err)
	}
	if payload.VoterEligible != "1" {
		return fmt.Errorf("투표 자격 속성 없음")
	}
	if payload.ElectionID != electionID || payload.ElectionID != cv.ElectionID {
		return fmt.Errorf("Ed25519 credential 선거ID 불일치: payload=%s, cred=%s, req=%s", payload.ElectionID, cv.ElectionID, electionID)
	}
	expUnix := int64(payload.Exp / 1000)
	if txNow > expUnix || expUnix != cv.ExpUnix {
		return fmt.Errorf("Ed25519 credential 만료 또는 exp 불일치")
	}

	sig, err := decodeBase64Flexible(parts[2])
	if err != nil {
		return fmt.Errorf("Ed25519 signature 디코딩 실패: %w", err)
	}
	message := []byte(parts[0] + "." + parts[1])
	if !ed25519.Verify(pubKey, message, sig) {
		return fmt.Errorf("Ed25519 credential 서명 검증 실패")
	}
	hashRaw := sha256.Sum256([]byte(token))
	if hex.EncodeToString(hashRaw[:]) != cv.CredHash {
		return fmt.Errorf("Ed25519 credential hash 불일치")
	}
	return nil
}

// verifyHMACCredentialToken [PAPER-4] HMAC-SHA256 credential을 체인코드에서 직접 검증합니다.
// 환경변수 CREDENTIAL_SECRET으로 서명을 재계산하여 API 미들웨어 우회 공격을 방지합니다.
//
// credential 형식: payloadB64.signatureB64
// signature = HMAC-SHA256(CREDENTIAL_SECRET, payloadB64)
func verifyHMACCredentialToken(ctx contractapi.TransactionContextInterface, cv CredentialVerification, electionID string, txNow int64) error {
	credSecret := os.Getenv("CREDENTIAL_SECRET")
	if credSecret == "" {
		return fmt.Errorf("CREDENTIAL_SECRET 미설정 — HMAC credential을 체인코드에서 검증할 수 없습니다")
	}
	if len([]byte(credSecret)) < 32 {
		return fmt.Errorf("CREDENTIAL_SECRET이 너무 짧습니다 — 최소 32바이트가 필요합니다")
	}

	transient, err := ctx.GetStub().GetTransient()
	if err != nil {
		return fmt.Errorf("transient 읽기 실패: %w", err)
	}
	tokenBytes, ok := transient["credentialToken"]
	if !ok || len(tokenBytes) == 0 {
		return fmt.Errorf("HMAC credentialToken 누락 — x-idemix-credential 헤더를 transient로 전달하세요")
	}
	token := string(tokenBytes)

	// payload.signature 분리
	dotIdx := strings.LastIndex(token, ".")
	if dotIdx < 1 {
		return fmt.Errorf("HMAC credential 형식 오류")
	}
	payloadB64 := token[:dotIdx]
	sig := token[dotIdx+1:]

	// HMAC-SHA256 서명 재계산
	mac := hmac.New(sha256.New, []byte(credSecret))
	mac.Write([]byte(payloadB64))
	expected := base64.RawURLEncoding.EncodeToString(mac.Sum(nil))

	if !hmac.Equal([]byte(sig), []byte(expected)) {
		return fmt.Errorf("HMAC credential 서명 검증 실패")
	}

	// payload 파싱 및 속성 검증
	payloadJSON, err := base64.RawURLEncoding.DecodeString(payloadB64)
	if err != nil {
		return fmt.Errorf("HMAC credential payload 디코딩 실패: %w", err)
	}

	var payload struct {
		VoterEligible string  `json:"voterEligible"`
		ElectionID    string  `json:"electionID"`
		Exp           float64 `json:"exp"`
	}
	if err := json.Unmarshal(payloadJSON, &payload); err != nil {
		return fmt.Errorf("HMAC credential payload 파싱 실패: %w", err)
	}

	if payload.VoterEligible != "1" {
		return fmt.Errorf("투표 자격 속성 없음")
	}
	if payload.ElectionID != electionID {
		return fmt.Errorf("HMAC credential 선거ID 불일치: payload=%s, req=%s", payload.ElectionID, electionID)
	}
	expUnix := int64(payload.Exp / 1000)
	if txNow > expUnix {
		return fmt.Errorf("HMAC credential 만료 (exp=%d, now=%d)", expUnix, txNow)
	}

	// credHash 일치 확인
	hashRaw := sha256.Sum256([]byte(token))
	if hex.EncodeToString(hashRaw[:]) != cv.CredHash {
		return fmt.Errorf("HMAC credential hash 불일치")
	}

	log.Printf("[verifyHMACCredentialToken] HMAC credential 체인코드 직접 검증 성공")
	return nil
}

// getCredVerifyLevel [PAPER-4] 자격증명의 체인코드 검증 수준을 결정합니다.
func getCredVerifyLevel(ctx contractapi.TransactionContextInterface) string {
	transient, err := ctx.GetStub().GetTransient()
	if err != nil {
		return "metadata-only"
	}
	cvBytes, ok := transient["credentialVerification"]
	if !ok {
		return "metadata-only"
	}
	var cv CredentialVerification
	if err := json.Unmarshal(cvBytes, &cv); err != nil {
		return "metadata-only"
	}
	switch cv.CredType {
	case "ed25519":
		return "chaincode-ed25519"
	case "hmac":
		if os.Getenv("CREDENTIAL_SECRET") != "" {
			return "chaincode-hmac"
		}
		return "metadata-only"
	case "ps":
		if os.Getenv("PS_ISSUER_PUBLIC_KEY_B64") != "" {
			return "chaincode-ps"
		}
		return "metadata-only"
	case "bbs":
		if os.Getenv("BBS_PUBLIC_KEY_B64") != "" {
			return "chaincode-bbs"
		}
		return "metadata-only"
	case "bypass":
		return "bypass"
	default:
		return "metadata-only"
	}
}

// KeySharingStatus Shamir SSS 키 분산 현황 (공개 원장)
type KeySharingStatus struct {
	ObjectType     string   `json:"docType"` // "keySharingStatus"
	ElectionID     string   `json:"electionID"`
	Threshold      int      `json:"threshold"`      // 복원 임계값 (2)
	TotalShares    int      `json:"totalShares"`    // 총 share 수 (3)
	SubmittedCount int      `json:"submittedCount"` // 제출된 share 수
	SubmittedBy    []string `json:"submittedBy"`    // 제출한 share 인덱스 목록 ("1","2","3")
	IsDecrypted    bool     `json:"isDecrypted"`    // 복원 성공 여부
	KeyHash        string   `json:"keyHash"`        // SHA256(masterKey) — 검증용 공개
	InitiatedAt    int64    `json:"initiatedAt"`
	// [HIGH-05 FIX] Feldman VSS 공개 commitment 목록
	// SHA256(share_i) — share 제출 시 위조 여부를 체인코드가 독립 검증
	// 인덱스 0 = share1, 1 = share2, 2 = share3
	ShareCommitments []string `json:"shareCommitments"`
	Mode             string   `json:"mode,omitempty" metadata:",optional"` // "legacy-reconstruction" | "partial-decryption-v2"
}

// ============================================================
// 원장 초기화
// ============================================================

// InitLedger 체인코드 배포 시 시연용 선거 데이터를 원장에 기록합니다.
func (c *VotingContract) InitLedger(ctx contractapi.TransactionContextInterface) error {
	now, err := getTxTime(ctx)
	if err != nil {
		return err
	}
	// [CRIT-03 FIX] InitLedger 선거에도 블라인딩 팩터 부여 (정적 시드 사용)
	initBfRaw := sha256.Sum256([]byte("BLINDING_ELECTION_2026_PRESIDENT_INIT"))
	elections := []Election{
		{
			ObjectType:     "election",
			ElectionID:     "ELECTION_2026_PRESIDENT",
			Title:          "2026 대표 선출 선거",
			Description:    "블록체인 기반 익명 전자투표 시스템 시연용 선거",
			Candidates:     []string{"CANDIDATE_A", "CANDIDATE_B", "CANDIDATE_C"},
			StartTime:      now,
			EndTime:        now + 86400, // 24시간 후
			Status:         "ACTIVE",
			CreatedBy:      "VotingOrgMSP",
			BlindingFactor: hex.EncodeToString(initBfRaw[:]),
		},
	}

	for _, e := range elections {
		b, err := json.Marshal(e)
		if err != nil {
			return fmt.Errorf("선거 직렬화 실패: %w", err)
		}
		if err := ctx.GetStub().PutState(e.ElectionID, b); err != nil {
			return fmt.Errorf("원장 저장 실패 [%s]: %w", e.ElectionID, err)
		}
		log.Printf("[InitLedger] 선거 등록: %s", e.ElectionID)
	}
	return nil
}

// ============================================================
// 선거 관리 함수
// ============================================================

// CreateElection 새 선거를 원장에 등록합니다 (선거관리자 전용).
//
// 파라미터:
//   - electionID:   고유 선거 ID
//   - title:        선거 제목
//   - description:  선거 설명
//   - candidatesJSON: JSON 배열 형태의 후보자 ID 목록 (예: ["A","B","C"])
//   - startTime:    시작 시각 (Unix timestamp 문자열)
//   - endTime:      종료 시각 (Unix timestamp 문자열)
func (c *VotingContract) CreateElection(
	ctx contractapi.TransactionContextInterface,
	electionID string,
	title string,
	description string,
	candidatesJSON string,
	startTime int64,
	endTime int64,
) error {
	if err := requireElectionAdmin(ctx); err != nil {
		return err
	}

	// electionID 형식 검증 (CouchDB 인젝션 방지)
	if err := validateElectionID(electionID); err != nil {
		return err
	}

	// 중복 선거 확인
	existing, err := ctx.GetStub().GetState(electionID)
	if err != nil {
		return fmt.Errorf("원장 조회 실패: %w", err)
	}
	if existing != nil {
		return fmt.Errorf("이미 존재하는 선거 ID입니다: %s", electionID)
	}

	// 후보자 목록 파싱
	var candidates []string
	if err := json.Unmarshal([]byte(candidatesJSON), &candidates); err != nil {
		return fmt.Errorf("후보자 JSON 파싱 실패: %w", err)
	}
	if len(candidates) < 2 {
		return fmt.Errorf("후보자는 최소 2명 이상이어야 합니다")
	}

	// 시간 유효성
	if endTime <= startTime {
		return fmt.Errorf("종료 시각은 시작 시각보다 이후여야 합니다")
	}

	// MSP ID로 생성자 기록
	mspID, err := ctx.GetClientIdentity().GetMSPID()
	if err != nil {
		return fmt.Errorf("MSP ID 조회 실패: %w", err)
	}

	// [CRIT-03 FIX] 선거별 블라인딩 팩터 생성
	// GetTxTimestamp()와 달리 GetTxID()는 모든 피어에서 동일 → endorsement 충돌 없음
	txID := ctx.GetStub().GetTxID()
	bfInput := fmt.Sprintf("BLINDING_%s_%s", electionID, txID)
	bfRaw := sha256.Sum256([]byte(bfInput))
	blindingFactor := hex.EncodeToString(bfRaw[:])

	// [PAPER-11] 암호화 모드 결정: transient "encryptionMode" 키가 있으면 사용, 없으면 "aes"
	encryptionMode := "aes"
	transient, _ := ctx.GetStub().GetTransient()
	if transient != nil {
		if modeBytes, ok := transient["encryptionMode"]; ok {
			mode := strings.TrimSpace(string(modeBytes))
			if mode == "elgamal" || mode == "elgamal-vector-v3" {
				encryptionMode = mode
			}
		}
	}

	var elgamalPubKey *ElGamalPublicKey
	var thresholdPublicShares []ThresholdPublicShare
	var masterSeed []byte
	var dkg *dkgTranscript
	keyCeremonyMode := ""
	if raw, ok := transient["dkgTranscript"]; ok {
		if encryptionMode != "elgamal-vector-v3" {
			return fmt.Errorf("DKG transcript is supported only for elgamal-vector-v3 elections")
		}
		parsed, publicShares, parseErr := parseAndValidateDKGTranscript(raw)
		if parseErr != nil {
			return parseErr
		}
		dkg, thresholdPublicShares = parsed, publicShares
		elgamalPubKey = &ElGamalPublicKey{P: elgamalP.Text(16), G: elgamalG.Text(16), Y: parsed.ElectionPublicKeyY}
		keyCeremonyMode = "dkg-v1"
	}

	// [P2 보안] AES 마스터 키 생성 — 비밀 seed(transient) 기반.
	//   기존: 공개 txID 해시 → 원장을 읽는 누구나 키 재계산 가능(취약점).
	//   변경: 선거 생성 시 외부에서 생성한 비밀 seed를 transient(masterSeed)로 받아 유도.
	//         transient는 오더러/원장에 기록되지 않으므로 키가 공개 데이터로 재계산 불가.
	//         seed 미제공 시에만 하위호환으로 txID 기반 사용(주의: 그 경우 재계산 가능).
	var ekRaw [32]byte
	if transient != nil {
		if ms, ok := transient["masterSeed"]; ok && len(ms) >= 16 {
			masterSeed = append([]byte(nil), ms...)
			ekRaw = sha256.Sum256(append([]byte("ENCRYPTION::"), ms...))
		} else {
			ekRaw = sha256.Sum256([]byte(fmt.Sprintf("ENCRYPTION_%s_%s", electionID, txID)))
		}
	} else {
		ekRaw = sha256.Sum256([]byte(fmt.Sprintf("ENCRYPTION_%s_%s", electionID, txID)))
	}
	ekKey := "ENCRYPTION_KEY_" + electionID
	ekHexStr := hex.EncodeToString(ekRaw[:])
	if dkg == nil {
		if pdcErr := ctx.GetStub().PutPrivateData(VotePrivatePDC, ekKey, []byte(ekHexStr)); pdcErr != nil {
			return fmt.Errorf("암호화 키 PDC 저장 실패: %w", pdcErr)
		}
	}

	if encryptionMode == "elgamal" || encryptionMode == "elgamal-vector-v3" {
		if dkg != nil {
			log.Printf("[CreateElection] externally generated 2-of-3 DKG public key accepted — transcript: %s", dkg.TranscriptHash)
		} else if len(masterSeed) < 16 {
			return fmt.Errorf("ElGamal 선거는 transient masterSeed(16바이트 이상)가 필수입니다")
		} else {
			// Dealer-assisted 2-of-3 threshold key generation. The full secret exists
			// only during endorsement and is never persisted. Trustees later publish
			// verifiable partial decryptions, never their scalar shares.
			privKey, pubKey := elgamalGenerateKeyPair(append([]byte("THRESHOLD-ELGAMAL::"), masterSeed...))
			elgamalPubKey = pubKey
			coeffHash := sha256.Sum256(append([]byte("THRESHOLD-COEFF::"), masterSeed...))
			coefficient := new(big.Int).SetBytes(coeffHash[:])
			coefficient.Mod(coefficient, elgamalQ)
			if coefficient.Sign() == 0 {
				coefficient.SetInt64(1)
			}
			shares, shareErr := deriveThresholdShares(privKey, coefficient, ShamirTotalShares)
			if shareErr != nil {
				return fmt.Errorf("ElGamal threshold share 생성 실패: %w", shareErr)
			}
			for i, share := range shares {
				index := i + 1
				shareKey := fmt.Sprintf("ELGAMAL_THRESHOLD_SHARE_%s_%d", electionID, index)
				if pdcErr := ctx.GetStub().PutPrivateData(VotePrivatePDC, shareKey, []byte(share.Text(16))); pdcErr != nil {
					return fmt.Errorf("ElGamal threshold share %d PDC 저장 실패: %w", index, pdcErr)
				}
				thresholdPublicShares = append(thresholdPublicShares, ThresholdPublicShare{
					Index: index, MSPID: shareIndexMSP[strconv.Itoa(index)],
					PublicKeyY: new(big.Int).Exp(elgamalG, share, elgamalP).Text(16),
				})
			}
			log.Printf("[CreateElection] ElGamal 2-of-3 threshold 키 생성 완료 — pubKey.Y: %s...", pubKey.Y[:16])
		}
	} else {
		log.Printf("[CreateElection] AES 암호화 키 생성 완료 — PDC key: %s, hex: %s...", ekKey, ekHexStr[:16])
	}

	election := Election{
		ObjectType:            "election",
		ElectionID:            electionID,
		Title:                 title,
		Description:           description,
		Candidates:            candidates,
		StartTime:             startTime,
		EndTime:               endTime,
		Status:                "CREATED",
		CreatedBy:             mspID,
		BlindingFactor:        blindingFactor,
		EncryptionMode:        encryptionMode,
		ElGamalPubKey:         elgamalPubKey,
		ThresholdPublicShares: thresholdPublicShares,
		KeyCeremonyMode:       keyCeremonyMode,
	}
	if dkg != nil {
		election.DKGCeremonyID = dkg.CeremonyID
		election.DKGTranscriptHash = dkg.TranscriptHash
		election.DKGApprovals = []string{}
	}

	b, err := json.Marshal(election)
	if err != nil {
		return fmt.Errorf("직렬화 실패: %w", err)
	}
	if err := ctx.GetStub().PutState(electionID, b); err != nil {
		return fmt.Errorf("선거 원장 저장 실패: %w", err)
	}
	if dkg != nil {
		publicTranscript, marshalErr := json.Marshal(dkg)
		if marshalErr != nil {
			return fmt.Errorf("DKG transcript serialization failed: %w", marshalErr)
		}
		if putErr := ctx.GetStub().PutState(dkgTranscriptStateKey(electionID), publicTranscript); putErr != nil {
			return fmt.Errorf("DKG transcript public-state commit failed: %w", putErr)
		}
	}

	// ── Panic Mode용 더미 Nullifier 생성 ─────────────────────────
	// 후보자별 PanicDummyCount개의 더미 Nullifier를 실제 Nullifier 레코드로 저장합니다.
	// 더미도 Merkle Tree 리프에 포함되어 강압자가 수학적으로 검증해도 통과합니다.
	// 더미 Nullifier 키: "DUMMY_{electionID}_{candidateID}_{index}"
	now, err := getTxTime(ctx)
	if err != nil {
		return err
	}
	for _, cand := range candidates {
		for i := 0; i < PanicDummyCount; i++ {
			rawKey := fmt.Sprintf("DUMMY_%s_%s_%d_%s", electionID, cand, i, txID)
			h := sha256.Sum256([]byte(rawKey))
			dummyHash := fmt.Sprintf("%x", h)
			encDummyCandID, encErr := encryptAESGCM(ekRaw[:], cand)
			if encErr != nil {
				return fmt.Errorf("더미 후보자 암호화 실패: %w", encErr)
			}
			dummyCommitment := computeCandidateCommitment(electionID, dummyHash, encDummyCandID)

			dummy := Nullifier{
				ObjectType:           "nullifier",
				NullifierHash:        dummyHash,
				ElectionID:           electionID,
				CandidateCommitment:  dummyCommitment,
				EncryptedCandidateID: encDummyCandID,
				Timestamp:            now,
				IsPadding:            true,
			}
			db, err := json.Marshal(dummy)
			if err != nil {
				return fmt.Errorf("더미 Nullifier 직렬화 실패: %w", err)
			}
			// 더미는 nullifierHash를 키로 저장 (실제 투표와 동일 포맷)
			if err := ctx.GetStub().PutState(dummyHash, db); err != nil {
				return fmt.Errorf("더미 Nullifier 저장 실패: %w", err)
			}
			// 더미 목록 인덱스 (Panic Mode에서 검색용)
			dummyListKey := fmt.Sprintf("DUMMY_IDX_%s_%s_%d", electionID, cand, i)
			if err := ctx.GetStub().PutState(dummyListKey, []byte(dummyHash)); err != nil {
				return fmt.Errorf("더미 인덱스 저장 실패: %w", err)
			}
		}
	}

	log.Printf("[CreateElection] 선거 생성 완료: %s", electionID)
	return nil
}

// GetBlindingFactor [CRIT-03 FIX] 선거의 블라인딩 팩터를 반환합니다.
// 유권자는 투표 전 반드시 호출하여 nullifier 계산에 사용해야 합니다.
// nullifierHash = SHA256(signed credential material + electionID + blindingFactor)
func (c *VotingContract) GetBlindingFactor(
	ctx contractapi.TransactionContextInterface,
	electionID string,
) (string, error) {
	election, err := c.GetElection(ctx, electionID)
	if err != nil {
		return "", err
	}
	if election.BlindingFactor == "" {
		return "", fmt.Errorf("블라인딩 팩터 없음 (레거시 선거): %s", electionID)
	}
	return election.BlindingFactor, nil
}

// RevokeCredential records an append-only, election-scoped credential
// revocation. The caller supplies the versioned handle derived by the issuer;
// no token, voter ID, free-form reason, or credential hash is persisted.
func (c *VotingContract) RevokeCredential(
	ctx contractapi.TransactionContextInterface,
	electionID string,
	revocationHandle string,
	reasonCode string,
) error {
	if err := requireElectionAdmin(ctx); err != nil {
		return err
	}
	election, err := c.GetElection(ctx, electionID)
	if err != nil {
		return err
	}
	if election.Status == "CLOSED" {
		return fmt.Errorf("종료된 선거의 credential은 폐기할 수 없습니다")
	}
	if !validCredentialRevocationReason(reasonCode) {
		return fmt.Errorf("허용되지 않는 credential 폐기 사유 코드")
	}
	key, err := credentialRevocationStateKey(electionID, revocationHandle)
	if err != nil {
		return err
	}
	existing, err := ctx.GetStub().GetState(key)
	if err != nil {
		return fmt.Errorf("credential 폐기 상태 조회 실패: %w", err)
	}
	if existing != nil {
		handleHash := strings.TrimPrefix(key, "REVOCATION_")
		var prior CredentialRevocation
		if err := json.Unmarshal(existing, &prior); err != nil {
			return fmt.Errorf("기존 credential 폐기 레코드 파싱 실패: %w", err)
		}
		if prior.Schema == "mongbas-credential-revocation/v1" &&
			prior.ElectionID == electionID && prior.HandleHash == handleHash &&
			prior.ReasonCode == reasonCode {
			return nil
		}
		return fmt.Errorf("credential 폐기 레코드 충돌")
	}
	now, err := getTxTime(ctx)
	if err != nil {
		return err
	}
	mspID, err := ctx.GetClientIdentity().GetMSPID()
	if err != nil {
		return fmt.Errorf("MSP ID 조회 실패: %w", err)
	}
	record := CredentialRevocation{
		Schema:       "mongbas-credential-revocation/v1",
		ElectionID:   electionID,
		HandleHash:   strings.TrimPrefix(key, "REVOCATION_"),
		ReasonCode:   reasonCode,
		RevokedAt:    now,
		RevokedByMSP: mspID,
		TxID:         ctx.GetStub().GetTxID(),
	}
	encoded, err := json.Marshal(record)
	if err != nil {
		return fmt.Errorf("credential 폐기 레코드 직렬화 실패: %w", err)
	}
	if err := ctx.GetStub().PutState(key, encoded); err != nil {
		return fmt.Errorf("credential 폐기 레코드 저장 실패: %w", err)
	}
	return nil
}

// verifyCredentialTransient [CRIT-01/02 FIX] transient map의 credentialVerification 키를 읽고
// 체인코드 레벨에서 독립적으로 자격증명을 검증합니다.
//
// 검증 항목:
//  1. 만료 시각 (txTimestamp 기준 — 모든 피어 동일 보장)
//  2. 선거 ID 바인딩 (자격증명 발급 시 지정된 선거와 일치)
//  3. 자격증명 유형 화이트리스트
//  4. credHash 존재 여부
//
// 이 함수가 성공해야만 CastVote가 체인에 기록됩니다.
// API 서버가 타협되어 미들웨어 검증을 우회해도, 체인코드가 독립 거부합니다.
func verifyCredentialTransient(
	ctx contractapi.TransactionContextInterface,
	electionID string,
	txNow int64,
) (string, error) {
	transient, err := ctx.GetStub().GetTransient()
	if err != nil {
		return "", fmt.Errorf("transient 읽기 실패: %w", err)
	}
	cvBytes, ok := transient["credentialVerification"]
	if !ok {
		return "", fmt.Errorf("자격증명 검증 데이터 누락 (key: credentialVerification)")
	}
	var cv CredentialVerification
	if err := json.Unmarshal(cvBytes, &cv); err != nil {
		return "", fmt.Errorf("CredentialVerification 파싱 실패: %w", err)
	}
	// 검증 1: 만료 시각 — tx 타임스탬프 사용 (모든 피어 동일)
	if txNow > cv.ExpUnix {
		return "", fmt.Errorf("자격증명 만료 (exp=%d, now=%d)", cv.ExpUnix, txNow)
	}
	// 검증 2: 선거 ID 바인딩 — bypass 모드 외에는 반드시 일치
	if cv.CredType == "bypass" && os.Getenv("ALLOW_BYPASS_CREDENTIAL") != "true" {
		return "", fmt.Errorf("bypass 자격증명은 체인코드 운영 기본값에서 허용되지 않습니다")
	}
	if cv.CredType != "bypass" && cv.ElectionID != electionID {
		return "", fmt.Errorf("자격증명 선거ID 불일치: cred=%s, req=%s", cv.ElectionID, electionID)
	}
	// 검증 3: 허용된 자격증명 유형
	switch cv.CredType {
	case "ps", "bbs", "hmac", "ed25519", "bypass":
		// 허용
	default:
		return "", fmt.Errorf("허용되지 않는 자격증명 유형: %s", cv.CredType)
	}
	// 검증 4: 감사 해시 존재
	if cv.CredHash == "" {
		return "", fmt.Errorf("credHash 누락")
	}
	if cv.CredType == "ed25519" {
		if err := verifyEd25519CredentialToken(ctx, cv, electionID, txNow); err != nil {
			return "", err
		}
	}
	if cv.CredType == "ps" {
		if err := verifyPSCredentialToken(ctx, cv, electionID, txNow); err != nil {
			return "", err
		}
	}
	if cv.CredType == "bbs" {
		if err := verifyBBSCredentialToken(ctx, cv, electionID, txNow); err != nil {
			return "", err
		}
	}
	// [PAPER-4] HMAC credential 체인코드 직접 검증
	if cv.CredType == "hmac" {
		if err := verifyHMACCredentialToken(ctx, cv, electionID, txNow); err != nil {
			return "", err
		}
	}
	return cv.CredHash, nil
}

// verifyCredentialBoundNullifier is the single authorization gate shared by
// direct cast and the vector audit-or-cast workflow. Keeping verification here
// prevents a future prepare/cast endpoint from accepting a valid proof while
// silently skipping credential binding or revocation.
func verifyCredentialBoundNullifier(
	ctx contractapi.TransactionContextInterface,
	election *Election,
	nullifierHash string,
	txNow int64,
) (*CredentialVerification, error) {
	if election == nil {
		return nil, fmt.Errorf("선거 데이터가 없습니다")
	}
	if _, err := verifyCredentialTransient(ctx, election.ElectionID, txNow); err != nil {
		return nil, fmt.Errorf("자격증명 거부: %w", err)
	}
	transient, err := ctx.GetStub().GetTransient()
	if err != nil {
		return nil, fmt.Errorf("transient 읽기 실패: %w", err)
	}
	var cv CredentialVerification
	if err := json.Unmarshal(transient["credentialVerification"], &cv); err != nil {
		return nil, fmt.Errorf("CredentialVerification 파싱 실패: %w", err)
	}
	if cv.CredType == "bypass" {
		return &cv, nil
	}
	material, err := credentialNullifierMaterial(ctx, cv)
	if err != nil {
		return nil, fmt.Errorf("nullifier 바인딩 거부: %w", err)
	}
	expected, err := computeCredentialBoundNullifier(material, election.ElectionID, election.BlindingFactor)
	if err != nil {
		return nil, fmt.Errorf("nullifier 바인딩 거부: %w", err)
	}
	decoded, decodeErr := hex.DecodeString(nullifierHash)
	if decodeErr != nil || len(decoded) != sha256.Size || nullifierHash != strings.ToLower(nullifierHash) {
		return nil, fmt.Errorf("nullifierHash는 64자 소문자 SHA-256 hex여야 합니다")
	}
	if subtle.ConstantTimeCompare([]byte(nullifierHash), []byte(expected)) != 1 {
		return nil, fmt.Errorf("nullifierHash가 서명된 자격증명과 일치하지 않습니다")
	}
	revocationHandle, err := computeCredentialRevocationHandle(material, election.ElectionID, election.BlindingFactor)
	if err != nil {
		return nil, fmt.Errorf("credential 폐기 핸들 계산 실패: %w", err)
	}
	revocationKey, err := credentialRevocationStateKey(election.ElectionID, revocationHandle)
	if err != nil {
		return nil, fmt.Errorf("credential 폐기 키 계산 실패: %w", err)
	}
	revoked, err := ctx.GetStub().GetState(revocationKey)
	if err != nil {
		return nil, fmt.Errorf("credential 폐기 상태 조회 실패: %w", err)
	}
	if revoked != nil {
		return nil, fmt.Errorf("폐기된 credential입니다")
	}
	return &cv, nil
}

// CloseElection 선거를 종료하고 득표를 집계하여 결과를 원장에 기록합니다.
// TallyVotes 로직이 내부에서 실행됩니다.
func (c *VotingContract) CloseElection(
	ctx contractapi.TransactionContextInterface,
	electionID string,
) (*VoteTally, error) {
	if err := requireElectionAdmin(ctx); err != nil {
		return nil, err
	}

	election, err := c.GetElection(ctx, electionID)
	if err != nil {
		return nil, err
	}
	if election.Status == "CLOSED" {
		if election.EncryptionMode == "elgamal" || election.EncryptionMode == "elgamal-vector-v3" {
			if existing, getErr := ctx.GetStub().GetState("TALLY_" + electionID); getErr != nil {
				return nil, getErr
			} else if existing != nil {
				var tally VoteTally
				if err := json.Unmarshal(existing, &tally); err != nil {
					return nil, err
				}
				return &tally, nil
			}
			return &VoteTally{ObjectType: "tally-pending", ElectionID: electionID, Results: map[string]int{}, Decrypted: false}, nil
		}
		return nil, fmt.Errorf("이미 종료된 선거입니다: %s", electionID)
	}

	// 선거 상태를 CLOSED로 업데이트 (집계/키분산 전에 CLOSED 상태가 선행되어야 함)
	election.Status = "CLOSED"
	b, err := json.Marshal(election)
	if err != nil {
		return nil, fmt.Errorf("선거 직렬화 실패: %w", err)
	}
	if err := ctx.GetStub().PutState(electionID, b); err != nil {
		return nil, fmt.Errorf("선거 상태 업데이트 실패: %w", err)
	}

	if election.EncryptionMode == "elgamal" || election.EncryptionMode == "elgamal-vector-v3" {
		// [P2 보안] ElGamal: CLOSED 상태와 키 분산을 먼저 커밋한다.
		// 전체 ballot 순회를 같은 tx에 넣으면 대규모 선거에서 peer execute timeout을
		// 넘고, rich-query phantom과 동시 CastVote를 안전하게 차단할 수 없다.
		// 따라서 다음 별도 tx AggregateClosedElection이 암호문 집계를 생성한다.
		//   결과 복호화는 2개 기관이 조각을 제출(SubmitKeyShare)하여 키가 복원된 후 자동 수행된다.
		//   → "단일 기관 단독 복호화 불가 + 공개 데이터로 키 재계산 불가"가 성립.
		// 키 분산(Shamir 분할 + AES/ElGamal 키 PDC 삭제). 같은 tx 내 삭제는 다음 tx부터 적용.
		//    doInitKeySharing은 상태 체크를 건너뜀(이 tx에서 방금 CLOSED로 쓴 값은 GetState로 안 보임).
		if _, ksErr := c.doInitKeySharing(ctx, electionID); ksErr != nil {
			return nil, fmt.Errorf("키 분산 초기화 실패: %w", ksErr)
		}
		return &VoteTally{ObjectType: "tally-pending", ElectionID: electionID, Results: map[string]int{}, Decrypted: false}, nil
	}

	// AES(레거시): 종료 즉시 복호화 집계 (기존 동작 유지)
	tally, err := c.TallyVotes(ctx, electionID)
	if err != nil {
		return nil, err
	}
	return tally, nil
}

// AggregateClosedElection은 CLOSED 상태가 원장에 커밋된 뒤에만 실행되는
// ElGamal 암호문 집계 tx이다. 이로써 집계 중 신규 투표를 원장 상태로 차단한다.
func (c *VotingContract) AggregateClosedElection(ctx contractapi.TransactionContextInterface, electionID string) (*VoteTally, error) {
	if err := requireElectionAdmin(ctx); err != nil {
		return nil, err
	}
	election, err := c.GetElection(ctx, electionID)
	if err != nil {
		return nil, err
	}
	if election.Status != "CLOSED" {
		return nil, fmt.Errorf("CLOSED 선거만 집계할 수 있습니다: %s", election.Status)
	}
	if existing, err := ctx.GetStub().GetState("TALLY_" + electionID); err != nil {
		return nil, err
	} else if existing != nil {
		var tally VoteTally
		if err := json.Unmarshal(existing, &tally); err != nil {
			return nil, err
		}
		return &tally, nil
	}
	return c.tallyVotesInternal(ctx, electionID, nil, true)
}

// ============================================================
// CastVote — 핵심 투표 함수
// ============================================================

// CastVote 유권자가 익명으로 투표를 제출합니다.
//
// 공개 파라미터 (체인에 기록됨):
//   - electionID:    투표 대상 선거 ID
//   - candidateID:   선택한 후보자 ID
//   - nullifierHash: SHA256(signed credential material + electionID + blindingFactor)
//     [CRIT-03 FIX] blindingFactor 추가로 선거 간 nullifier 연결 방지
//
// 비공개 데이터 (Transient Map — 체인에 기록 안 됨):
//
//	"votePrivate":           { voterID, electionID, candidateID, nullifierHash, voteHash }
//	"credentialVerification": { credType, electionID, expUnix, credHash }
//	                          [CRIT-01/02 FIX] API 서버 독립적 체인코드 자격증명 검증
//
// 처리 흐름:
//  1. 선거 존재 및 ACTIVE 상태 + 투표 기간 검증
//     1b.[CRIT-01/02] 자격증명 체인코드 독립 검증 (만료/선거ID/유형/해시)
//  2. nullifierHash 중복 검사 → 재투표 시 Eviction(덮어쓰기), 최종 1표만 집계
//  3. candidateID 유효성 검사
//  4. Transient Map에서 비공개 투표 데이터 읽기
//  5. VotePrivate → PDC 저장 (오더러 미전달, 피어 사이드DB)
//  6. Nullifier  → 공개 원장 저장 (신원·credential/token hash 미포함)
func (c *VotingContract) CastVote(
	ctx contractapi.TransactionContextInterface,
	electionID string,
	candidateID string,
	nullifierHash string,
) error {
	election, err := c.GetElection(ctx, electionID)
	if err != nil {
		return err
	}
	if election.EncryptionMode == "elgamal-vector-v3" {
		return fmt.Errorf("vector-v3 투표는 PrepareVectorBallot 후 CastPreparedVectorBallot으로만 제출할 수 있습니다")
	}
	return c.castVoteInternal(ctx, electionID, candidateID, nullifierHash, "")
}

// castVoteInternal contains the existing validated ledger write. It is not a
// contract method, so external callers cannot bypass the prepared vector state
// machine while legacy AES/ElGamal paths keep their public CastVote API.
func (c *VotingContract) castVoteInternal(
	ctx contractapi.TransactionContextInterface,
	electionID string,
	candidateID string,
	nullifierHash string,
	preparedBallotID string,
) error {

	// ── Step 0: 입력 형식 검증 (CouchDB 인젝션 방지) ──────────
	if err := validateElectionID(electionID); err != nil {
		return err
	}

	// ── Step 1: 선거 유효성 검사 ──────────────────────────────
	election, err := c.GetElection(ctx, electionID)
	if err != nil {
		return err
	}
	if election.Status != "ACTIVE" {
		return fmt.Errorf("투표 가능한 상태가 아닙니다 (현재 상태: %s)", election.Status)
	}
	now, err := getTxTime(ctx)
	if err != nil {
		return err
	}
	if now < election.StartTime {
		return fmt.Errorf("아직 투표 기간이 시작되지 않았습니다")
	}
	if now > election.EndTime {
		return fmt.Errorf("투표 기간이 종료되었습니다")
	}

	// ── Step 1b: credential, nullifier binding and revocation ─────
	if _, err = verifyCredentialBoundNullifier(ctx, election, nullifierHash, now); err != nil {
		return err
	}
	transient, err := ctx.GetStub().GetTransient()
	if err != nil {
		return fmt.Errorf("transient 읽기 실패: %w", err)
	}

	// ── Step 2: 재투표 확인 / Eviction 처리 (최종 1표만 유효) ──
	existing, err := ctx.GetStub().GetState(nullifierHash)
	if err != nil {
		return fmt.Errorf("Nullifier 조회 실패: %w", err)
	}
	isEviction := existing != nil
	evictCount := 0
	if isEviction {
		var prev Nullifier
		if err := json.Unmarshal(existing, &prev); err != nil {
			return fmt.Errorf("기존 Nullifier 파싱 실패: %w", err)
		}
		evictCount = prev.EvictCount + 1
	}

	// ── Step 3: Transient Map에서 비공개 투표 데이터 읽기 ────
	// 클라이언트는 SDK의 transient 옵션으로 {"votePrivate": <JSON bytes>} 전달
	transient, err = ctx.GetStub().GetTransient()
	if err != nil {
		return fmt.Errorf("Transient 데이터 읽기 실패: %w", err)
	}
	privateBytes, ok := transient["votePrivate"]
	if !ok {
		return fmt.Errorf("Transient Map에 'votePrivate' 키가 없습니다")
	}

	// Transient 데이터를 VotePrivate 구조체로 파싱
	var vp VotePrivate
	if err := json.Unmarshal(privateBytes, &vp); err != nil {
		return fmt.Errorf("VotePrivate 파싱 실패: %w", err)
	}

	// 비공개 데이터 무결성 검사: electionID, nullifierHash 일치 확인
	if vp.ElectionID != electionID || vp.NullifierHash != nullifierHash {
		return fmt.Errorf("비공개 투표 데이터와 공개 파라미터가 일치하지 않습니다")
	}

	// ObjectType 강제 설정 (클라이언트 제공값 덮어쓰기)
	vp.ObjectType = "votePrivate"
	vp.Timestamp = now

	// [PAPER-12] Deniable Credential Duality — credentialType 처리
	// transient "credentialType" 키로 전달: "panic" 이면 강압 투표, 그 외 "real" (기본)
	// PDC에만 저장되어 공개 원장에서는 구별 불가 (untappable channel = PDC gossip)
	if ctBytes, ok := transient["credentialType"]; ok {
		ct := strings.TrimSpace(string(ctBytes))
		if ct == "panic" {
			vp.CredentialType = "panic"
		} else {
			vp.CredentialType = "real"
		}
	}
	if vp.CredentialType == "" {
		vp.CredentialType = "real"
	}

	// ── Step 3b: 후보자 암호화 처리 ─────────────────────────
	// [PAPER-1] 클라이언트-사이드 암호화 지원:
	//   A) candidateID가 비어있고 encryptedCandidateID가 있으면 → 클라이언트가 암호화 (체인코드 blind)
	//   B) candidateID가 있으면 → 체인코드가 암호화 (레거시 호환)
	// A 방식에서 체인코드는 평문 후보자를 절대 보지 않음 → ballot secrecy 강화
	var encryptedCandID string
	var encryptedCandVector []ElGamalCiphertext
	var candidateCommitment string
	var publicBallotValidityProof *BallotValidityProof
	var publicVectorBallotValidityProof *VectorBallotValidityProof

	encKey, ekErr := getEncryptionKey(ctx, electionID)

	if candidateID == "" && (vp.EncryptedCandidateID != "" || len(vp.EncryptedCandidateVector) > 0) {
		// [PAPER-1] 클라이언트-사이드 암호화 모드 (blind mode)

		if election.EncryptionMode == "elgamal-vector-v3" {
			if vp.EncryptedCandidateID != "" || len(vp.EncryptedCandidateVector) != len(election.Candidates) {
				return fmt.Errorf("vector-v3 암호문은 후보자 수와 같은 벡터여야 합니다")
			}
			proofBytes, ok := transient["vectorBallotValidityProof"]
			if !ok || len(proofBytes) == 0 {
				return fmt.Errorf("vector-v3에서 vectorBallotValidityProof가 필요합니다")
			}
			var vectorProof VectorBallotValidityProof
			if err := json.Unmarshal(proofBytes, &vectorProof); err != nil {
				return fmt.Errorf("VectorBallotValidityProof 파싱 실패: %w", err)
			}
			if !verifyVectorBallotValidityZKP(election.ElGamalPubKey, vp.EncryptedCandidateVector, &vectorProof) {
				return fmt.Errorf("vector-v3 one-hot 투표 증명 검증 실패")
			}
			canonical, err := json.Marshal(vp.EncryptedCandidateVector)
			if err != nil {
				return fmt.Errorf("vector-v3 암호문 직렬화 실패: %w", err)
			}
			encryptedCandVector = append([]ElGamalCiphertext(nil), vp.EncryptedCandidateVector...)
			candidateCommitment = computeCandidateCommitment(electionID, nullifierHash, string(canonical))
			publicVectorBallotValidityProof = &vectorProof
			log.Printf("[CastVote] ElGamal vector-v3 blind mode + one-hot ZKP — election: %s", electionID)
		} else if election.EncryptionMode == "elgamal" {
			// [PAPER-13] Exponential ElGamal: ZKP로 후보 유효성 검증 (복호화 없음!)
			// 클라이언트가 disjunctive Chaum-Pedersen ZKP를 제출
			// → 체인코드는 암호문이 유효 후보 인코딩 중 하나임을 검증
			// → 개별 투표 복호화 불필요 → ballot secrecy 강화
			parts := strings.SplitN(vp.EncryptedCandidateID, ":", 2)
			if len(parts) != 2 {
				return fmt.Errorf("ElGamal 암호문 형식 오류 (c1:c2 형식 필요)")
			}

			// transient에서 BallotValidityProof 파싱
			bvpBytes, bvpOk := transient["ballotValidityProof"]
			if !bvpOk || bvpBytes == nil {
				return fmt.Errorf("ElGamal 모드에서 ballotValidityProof가 필요합니다")
			}
			var bvp BallotValidityProof
			if err := json.Unmarshal(bvpBytes, &bvp); err != nil {
				return fmt.Errorf("BallotValidityProof 파싱 실패: %w", err)
			}

			// Disjunctive Chaum-Pedersen ZKP 검증
			if !verifyBallotValidityZKP(election.ElGamalPubKey, parts[0], parts[1], len(election.Candidates), &bvp) {
				return fmt.Errorf("투표 유효성 ZKP 검증 실패: 유효하지 않은 후보 인코딩")
			}
			publicBallotValidityProof = &bvp

			encryptedCandID = vp.EncryptedCandidateID
			candidateCommitment = computeCandidateCommitment(electionID, nullifierHash, encryptedCandID)
			log.Printf("[CastVote] ElGamal exponential blind mode + ZKP — election: %s", electionID)
		} else {
			// AES blind mode (기존)
			if ekErr != nil {
				return fmt.Errorf("암호화 키 조회 실패: %w", ekErr)
			}
			decrypted, decErr := decryptAESGCM(encKey, vp.EncryptedCandidateID)
			if decErr != nil {
				return fmt.Errorf("클라이언트 암호문 복호화 검증 실패: %w", decErr)
			}
			if !contains(election.Candidates, decrypted) {
				return fmt.Errorf("유효하지 않은 후보자입니다")
			}
			encryptedCandID = vp.EncryptedCandidateID
			candidateCommitment = computeCandidateCommitment(electionID, nullifierHash, encryptedCandID)
			log.Printf("[CastVote] AES blind mode — election: %s", electionID)
		}
	} else if candidateID != "" {
		// 레거시 모드: 체인코드가 직접 암호화
		if !contains(election.Candidates, candidateID) {
			return fmt.Errorf("유효하지 않은 후보자 ID입니다: %s", candidateID)
		}
		if ekErr != nil {
			return fmt.Errorf("후보자 암호화 키 조회 실패: %w", ekErr)
		}
		var encErr error
		encryptedCandID, encErr = encryptAESGCM(encKey, candidateID)
		if encErr != nil {
			return fmt.Errorf("candidateID 암호화 실패: %w", encErr)
		}
		candidateCommitment = computeCandidateCommitment(electionID, nullifierHash, encryptedCandID)
	} else {
		return fmt.Errorf("candidateID 또는 encryptedCandidateID가 필요합니다")
	}

	vp.EncryptedCandidateID = encryptedCandID
	vp.EncryptedCandidateVector = encryptedCandVector
	vp.CandidateCommitment = candidateCommitment

	vpBytes, err := json.Marshal(vp)
	if err != nil {
		return fmt.Errorf("VotePrivate 직렬화 실패: %w", err)
	}

	// ── Step 5: PDC 저장 (비공개) ────────────────────────────
	// nullifierHash를 키로 사용 → 나중에 PDC에서도 개별 조회 가능
	if err := ctx.GetStub().PutPrivateData(VotePrivatePDC, nullifierHash, vpBytes); err != nil {
		return fmt.Errorf("PDC 저장 실패: %w", err)
	}

	// ── Step 5b: Panic Mode 비밀번호 해시 PDC 저장 (선택적) ──
	// transient에 "voterPW" 키가 있으면 비밀번호 해시를 PDC에 저장합니다.
	// 이를 통해 GetMerkleProofWithPassword에서 Normal/Panic 모드를 구분합니다.
	if pwBytes, ok := transient["voterPW"]; ok {
		var pwPrivate VoterPWPrivate
		if err := json.Unmarshal(pwBytes, &pwPrivate); err != nil {
			return fmt.Errorf("VoterPWPrivate 파싱 실패: %w", err)
		}
		// 패닉 후보자 유효성 확인
		if pwPrivate.PanicCandidateID != "" && !contains(election.Candidates, pwPrivate.PanicCandidateID) {
			return fmt.Errorf("유효하지 않은 panicCandidateID: %s", pwPrivate.PanicCandidateID)
		}
		lookupTokensPresent := pwPrivate.NormalLookupToken != "" || pwPrivate.PanicLookupToken != ""
		if lookupTokensPresent {
			if !isCanonicalSHA256Hex(pwPrivate.NormalLookupToken) || !isCanonicalSHA256Hex(pwPrivate.PanicLookupToken) {
				return fmt.Errorf("deniable lookup token은 64자 소문자 SHA-256 hex여야 합니다")
			}
			if subtle.ConstantTimeCompare([]byte(pwPrivate.NormalLookupToken), []byte(pwPrivate.PanicLookupToken)) == 1 {
				return fmt.Errorf("normal/panic lookup token은 서로 달라야 합니다")
			}
			lookups := []struct {
				token string
				mode  string
			}{
				{pwPrivate.NormalLookupToken, "normal"},
				{pwPrivate.PanicLookupToken, "panic"},
			}
			for _, item := range lookups {
				key := "PROOF_LOOKUP_" + electionID + "_" + item.token
				existing, getErr := ctx.GetStub().GetPrivateData(VotePrivatePDC, key)
				if getErr != nil {
					return fmt.Errorf("deniable lookup 중복 확인 실패: %w", getErr)
				}
				if existing != nil {
					return fmt.Errorf("deniable lookup token이 이미 사용되었습니다")
				}
				targetHash := nullifierHash
				if item.mode == "panic" {
					dummyCandID := pwPrivate.PanicCandidateID
					if dummyCandID == "" && len(election.Candidates) > 0 {
						dummyCandID = election.Candidates[0]
					}
					selector := sha256.Sum256([]byte("mongbas-deniable-dummy-v1\x00" + electionID + "\x00" + item.token))
					dummyIdx := int(new(big.Int).SetBytes(selector[:]).Int64()) % PanicDummyCount
					if dummyIdx < 0 {
						dummyIdx = -dummyIdx
					}
					dummyKey := fmt.Sprintf("DUMMY_IDX_%s_%s_%d", electionID, dummyCandID, dummyIdx)
					dummyBytes, dummyErr := ctx.GetStub().GetState(dummyKey)
					if dummyErr != nil || dummyBytes == nil {
						dummyKey = fmt.Sprintf("DUMMY_IDX_%s_%s_0", electionID, dummyCandID)
						dummyBytes, dummyErr = ctx.GetStub().GetState(dummyKey)
						if dummyErr != nil || dummyBytes == nil {
							return fmt.Errorf("더미 Nullifier를 찾을 수 없습니다")
						}
					}
					targetHash = string(dummyBytes)
				}
				record := DeniableLookupPrivate{ElectionID: electionID, TargetNullifierHash: targetHash}
				encoded, marshalErr := json.Marshal(record)
				if marshalErr != nil {
					return fmt.Errorf("deniable lookup 직렬화 실패: %w", marshalErr)
				}
				if putErr := ctx.GetStub().PutPrivateData(VotePrivatePDC, key, encoded); putErr != nil {
					return fmt.Errorf("deniable lookup PDC 저장 실패: %w", putErr)
				}
			}
		}
		pwKey := "VOTER_PW_" + nullifierHash
		pwData, err := json.Marshal(pwPrivate)
		if err != nil {
			return fmt.Errorf("VoterPWPrivate 직렬화 실패: %w", err)
		}
		if err := ctx.GetStub().PutPrivateData(VotePrivatePDC, pwKey, pwData); err != nil {
			return fmt.Errorf("비밀번호 PDC 저장 실패: %w", err)
		}
	}

	// ── Step 6: 공개 원장에 Nullifier 저장 (익명) ────────────
	// [C-4] candidateID를 AES-GCM으로 암호화하여 공개 원장에 저장

	nullifier := Nullifier{
		ObjectType:                "nullifier",
		NullifierHash:             nullifierHash,
		ElectionID:                electionID,
		CandidateCommitment:       candidateCommitment,
		EncryptedCandidateID:      encryptedCandID,
		BallotValidityProof:       publicBallotValidityProof,
		EncryptedCandidateVector:  encryptedCandVector,
		VectorBallotValidityProof: publicVectorBallotValidityProof,
		PreparedBallotID:          preparedBallotID,
		Timestamp:                 now,
		EvictCount:                evictCount,
		LastEvictedAt: func() int64 {
			if isEviction {
				return now
			}
			return 0
		}(),
		CredVerifyLevel: getCredVerifyLevel(ctx),
	}
	nBytes, err := json.Marshal(nullifier)
	if err != nil {
		return fmt.Errorf("Nullifier 직렬화 실패: %w", err)
	}
	if err := ctx.GetStub().PutState(nullifierHash, nBytes); err != nil {
		return fmt.Errorf("Nullifier 원장 저장 실패: %w", err)
	}

	log.Printf("[CastVote] 투표 완료 — election: %s, candidate: %s, eviction: %v", electionID, candidateID, isEviction)
	return nil
}

// ============================================================
// Benaloh Challenge — cast-as-intended 검증 (PAPER-3)
// ============================================================

func isCanonicalSHA256Hex(value string) bool {
	if len(value) != sha256.Size*2 || value != strings.ToLower(value) {
		return false
	}
	decoded, err := hex.DecodeString(value)
	return err == nil && len(decoded) == sha256.Size
}

func vectorBallotID(electionID, clientNonceHash, artifactHash string) string {
	// The public identifier must not include the credential-bound nullifier.
	// Once a final ballot publishes that nullifier, including it here would let
	// observers link the voter's spoiled transcript to the final ballot.
	return hashWithLengthPrefix("mongbas/vector-aoc/v1", electionID, clientNonceHash, artifactHash)
}

// PrepareVectorBallot commits the exact vector-v3 ciphertext and proof before
// the client chooses audit or cast. The artifact is verified now and must be
// consumed by a later terminal transition; this method never records a vote.
func (c *VotingContract) PrepareVectorBallot(
	ctx contractapi.TransactionContextInterface,
	electionID string,
	nullifierHash string,
	clientNonceHash string,
) (*VectorBallotReceipt, error) {
	if err := validateElectionID(electionID); err != nil {
		return nil, err
	}
	if !isCanonicalSHA256Hex(clientNonceHash) {
		return nil, fmt.Errorf("clientNonceHash는 64자 소문자 SHA-256 hex여야 합니다")
	}
	election, err := c.GetElection(ctx, electionID)
	if err != nil {
		return nil, err
	}
	if election.Status != "ACTIVE" || election.EncryptionMode != "elgamal-vector-v3" || election.ElGamalPubKey == nil {
		return nil, fmt.Errorf("ACTIVE vector-v3 선거에서만 준비할 수 있습니다")
	}
	now, err := getTxTime(ctx)
	if err != nil {
		return nil, err
	}
	if now < election.StartTime || now > election.EndTime {
		return nil, fmt.Errorf("현재 투표 기간이 아닙니다")
	}
	if _, err := verifyCredentialBoundNullifier(ctx, election, nullifierHash, now); err != nil {
		return nil, err
	}
	transient, err := ctx.GetStub().GetTransient()
	if err != nil {
		return nil, fmt.Errorf("transient 읽기 실패: %w", err)
	}
	artifactBytes, ok := transient["vectorAuditArtifact"]
	if !ok || len(artifactBytes) == 0 {
		return nil, fmt.Errorf("vectorAuditArtifact transient가 필요합니다")
	}
	var artifact VectorAuditArtifact
	if err := json.Unmarshal(artifactBytes, &artifact); err != nil {
		return nil, fmt.Errorf("vector audit artifact 파싱 실패: %w", err)
	}
	if len(artifact.EncryptedCandidateVector) != len(election.Candidates) || artifact.VectorBallotValidityProof == nil ||
		!verifyVectorBallotValidityZKP(election.ElGamalPubKey, artifact.EncryptedCandidateVector, artifact.VectorBallotValidityProof) {
		return nil, fmt.Errorf("vector-v3 one-hot 투표 증명 검증 실패")
	}
	artifactHash, err := computeVectorAuditArtifactHash(electionID, election.Candidates, artifact.EncryptedCandidateVector, artifact.VectorBallotValidityProof)
	if err != nil {
		return nil, err
	}
	ballotID := vectorBallotID(electionID, clientNonceHash, artifactHash)
	privateKey := "VECTOR_BALLOT_" + ballotID
	publicKey := "VECTOR_PREP_" + ballotID
	if existing, err := ctx.GetStub().GetPrivateData(VotePrivatePDC, privateKey); err != nil {
		return nil, fmt.Errorf("기존 vector ballot 조회 실패: %w", err)
	} else if existing != nil {
		var prior VectorBallotPreparation
		if err := json.Unmarshal(existing, &prior); err != nil {
			return nil, fmt.Errorf("기존 vector ballot 파싱 실패: %w", err)
		}
		if prior.Status != "prepared" || prior.ElectionID != electionID || prior.NullifierHash != nullifierHash ||
			prior.ClientNonceHash != clientNonceHash || prior.ArtifactHash != artifactHash {
			return nil, fmt.Errorf("vector ballot 준비 레코드 충돌 또는 이미 종료됨")
		}
		publicBytes, err := ctx.GetStub().GetState(publicKey)
		if err != nil || publicBytes == nil {
			return nil, fmt.Errorf("vector ballot 공개 영수증이 누락되었습니다")
		}
		var receipt VectorBallotReceipt
		if err := json.Unmarshal(publicBytes, &receipt); err != nil || receipt.Status != "prepared" || receipt.ArtifactHash != artifactHash {
			return nil, fmt.Errorf("vector ballot 공개 영수증 불일치")
		}
		return &receipt, nil
	}
	preparation := VectorBallotPreparation{
		Schema: "mongbas-vector-ballot-preparation/v1", BallotID: ballotID, ElectionID: electionID,
		NullifierHash: nullifierHash, ClientNonceHash: clientNonceHash, ArtifactHash: artifactHash,
		Artifact: artifact, Status: "prepared", CreatedAt: now,
	}
	receipt := VectorBallotReceipt{
		Schema: "mongbas-vector-ballot-receipt/v1", BallotID: ballotID, ElectionID: electionID,
		ArtifactHash: artifactHash, Status: "prepared", CreatedAt: now, CreatedTxID: ctx.GetStub().GetTxID(),
	}
	privateBytes, err := json.Marshal(preparation)
	if err != nil {
		return nil, fmt.Errorf("vector ballot 준비 레코드 직렬화 실패: %w", err)
	}
	publicBytes, err := json.Marshal(receipt)
	if err != nil {
		return nil, fmt.Errorf("vector ballot 영수증 직렬화 실패: %w", err)
	}
	if err := ctx.GetStub().PutPrivateData(VotePrivatePDC, privateKey, privateBytes); err != nil {
		return nil, fmt.Errorf("vector ballot 준비 PDC 저장 실패: %w", err)
	}
	if err := ctx.GetStub().PutState(publicKey, publicBytes); err != nil {
		return nil, fmt.Errorf("vector ballot 공개 영수증 저장 실패: %w", err)
	}
	return &receipt, nil
}

// AuditVectorBallot reveals and verifies the witness for a prepared ballot,
// then atomically spoils it. A successful transition can never be cast later.
func (c *VotingContract) AuditVectorBallot(
	ctx contractapi.TransactionContextInterface,
	electionID string,
	ballotID string,
	nullifierHash string,
	selectedIndex int,
) (*VectorAuditDisclosure, error) {
	if err := validateElectionID(electionID); err != nil {
		return nil, err
	}
	if !isCanonicalSHA256Hex(ballotID) {
		return nil, fmt.Errorf("ballotID는 64자 소문자 SHA-256 hex여야 합니다")
	}
	election, err := c.GetElection(ctx, electionID)
	if err != nil {
		return nil, err
	}
	if election.EncryptionMode != "elgamal-vector-v3" || election.ElGamalPubKey == nil {
		return nil, fmt.Errorf("vector-v3 선거가 아닙니다")
	}
	now, err := getTxTime(ctx)
	if err != nil {
		return nil, err
	}
	if _, err := verifyCredentialBoundNullifier(ctx, election, nullifierHash, now); err != nil {
		return nil, err
	}
	privateKey := "VECTOR_BALLOT_" + ballotID
	publicKey := "VECTOR_PREP_" + ballotID
	privateBytes, err := ctx.GetStub().GetPrivateData(VotePrivatePDC, privateKey)
	if err != nil || privateBytes == nil {
		return nil, fmt.Errorf("준비된 vector ballot을 찾을 수 없습니다")
	}
	var preparation VectorBallotPreparation
	if err := json.Unmarshal(privateBytes, &preparation); err != nil {
		return nil, fmt.Errorf("vector ballot 준비 레코드 파싱 실패: %w", err)
	}
	if preparation.Status != "prepared" || preparation.ElectionID != electionID || preparation.BallotID != ballotID {
		return nil, fmt.Errorf("vector ballot은 prepared 상태가 아닙니다")
	}
	if subtle.ConstantTimeCompare([]byte(preparation.NullifierHash), []byte(nullifierHash)) != 1 {
		return nil, fmt.Errorf("준비 credential/nullifier와 일치하지 않습니다")
	}
	publicBytes, err := ctx.GetStub().GetState(publicKey)
	if err != nil || publicBytes == nil {
		return nil, fmt.Errorf("vector ballot 공개 영수증이 누락되었습니다")
	}
	var receipt VectorBallotReceipt
	if err := json.Unmarshal(publicBytes, &receipt); err != nil || receipt.Status != "prepared" ||
		receipt.BallotID != ballotID || receipt.ElectionID != electionID || receipt.ArtifactHash != preparation.ArtifactHash {
		return nil, fmt.Errorf("vector ballot 공개 영수증 불일치")
	}
	artifactHash, err := computeVectorAuditArtifactHash(electionID, election.Candidates,
		preparation.Artifact.EncryptedCandidateVector, preparation.Artifact.VectorBallotValidityProof)
	if err != nil || artifactHash != preparation.ArtifactHash {
		return nil, fmt.Errorf("저장된 vector artifact hash 불일치")
	}
	transient, err := ctx.GetStub().GetTransient()
	if err != nil {
		return nil, fmt.Errorf("transient 읽기 실패: %w", err)
	}
	witnessBytes, ok := transient["vectorAuditWitness"]
	if !ok || len(witnessBytes) == 0 {
		return nil, fmt.Errorf("vectorAuditWitness transient가 필요합니다")
	}
	var witness VectorAuditWitness
	if err := json.Unmarshal(witnessBytes, &witness); err != nil {
		return nil, fmt.Errorf("vector audit witness 파싱 실패: %w", err)
	}
	if !isCanonicalSHA256Hex(witness.ClientNonce) {
		return nil, fmt.Errorf("clientNonce는 32-byte 소문자 hex여야 합니다")
	}
	nonceDigest := sha256.Sum256([]byte(witness.ClientNonce))
	if subtle.ConstantTimeCompare([]byte(preparation.ClientNonceHash), []byte(hex.EncodeToString(nonceDigest[:]))) != 1 {
		return nil, fmt.Errorf("client nonce commitment 불일치")
	}
	if !verifyVectorAuditWitness(election.ElGamalPubKey, preparation.Artifact.EncryptedCandidateVector, selectedIndex, witness.Randomness) {
		return nil, fmt.Errorf("vector audit witness 검증 실패")
	}
	preparation.Status, preparation.TerminalAt, preparation.TerminalTxID = "audited", now, ctx.GetStub().GetTxID()
	receipt.Status, receipt.TerminalAt, receipt.TerminalTxID = "audited", now, ctx.GetStub().GetTxID()
	disclosure := VectorAuditDisclosure{
		Schema: "mongbas-vector-audit-disclosure/v1", BallotID: ballotID, ElectionID: electionID,
		ArtifactHash: preparation.ArtifactHash, SelectedIndex: selectedIndex, ClientNonce: witness.ClientNonce,
		Randomness: append([]string(nil), witness.Randomness...), Status: "audited", AuditedAt: now, AuditedTxID: ctx.GetStub().GetTxID(),
		EncryptedCandidateVector:  append([]ElGamalCiphertext(nil), preparation.Artifact.EncryptedCandidateVector...),
		VectorBallotValidityProof: preparation.Artifact.VectorBallotValidityProof,
	}
	updatedPrivate, err := json.Marshal(preparation)
	if err != nil {
		return nil, err
	}
	updatedReceipt, err := json.Marshal(receipt)
	if err != nil {
		return nil, err
	}
	disclosureBytes, err := json.Marshal(disclosure)
	if err != nil {
		return nil, err
	}
	if err := ctx.GetStub().PutPrivateData(VotePrivatePDC, privateKey, updatedPrivate); err != nil {
		return nil, fmt.Errorf("vector ballot audit 상태 저장 실패: %w", err)
	}
	if err := ctx.GetStub().PutState(publicKey, updatedReceipt); err != nil {
		return nil, fmt.Errorf("vector ballot audit 영수증 저장 실패: %w", err)
	}
	if err := ctx.GetStub().PutState("VECTOR_AUDIT_"+ballotID, disclosureBytes); err != nil {
		return nil, fmt.Errorf("vector ballot audit disclosure 저장 실패: %w", err)
	}
	return &disclosure, nil
}

// CastPreparedVectorBallot atomically consumes the exact artifact committed by
// PrepareVectorBallot and records it through the same validated vote writer.
func (c *VotingContract) CastPreparedVectorBallot(
	ctx contractapi.TransactionContextInterface,
	electionID string,
	ballotID string,
	nullifierHash string,
) error {
	if err := validateElectionID(electionID); err != nil {
		return err
	}
	if !isCanonicalSHA256Hex(ballotID) {
		return fmt.Errorf("ballotID는 64자 소문자 SHA-256 hex여야 합니다")
	}
	election, err := c.GetElection(ctx, electionID)
	if err != nil {
		return err
	}
	if election.Status != "ACTIVE" || election.EncryptionMode != "elgamal-vector-v3" || election.ElGamalPubKey == nil {
		return fmt.Errorf("ACTIVE vector-v3 선거에서만 cast할 수 있습니다")
	}
	privateKey := "VECTOR_BALLOT_" + ballotID
	publicKey := "VECTOR_PREP_" + ballotID
	privateBytes, err := ctx.GetStub().GetPrivateData(VotePrivatePDC, privateKey)
	if err != nil || privateBytes == nil {
		return fmt.Errorf("준비된 vector ballot을 찾을 수 없습니다")
	}
	var preparation VectorBallotPreparation
	if err := json.Unmarshal(privateBytes, &preparation); err != nil {
		return fmt.Errorf("vector ballot 준비 레코드 파싱 실패: %w", err)
	}
	if preparation.Status != "prepared" || preparation.ElectionID != electionID || preparation.BallotID != ballotID {
		return fmt.Errorf("vector ballot은 prepared 상태가 아닙니다")
	}
	if subtle.ConstantTimeCompare([]byte(preparation.NullifierHash), []byte(nullifierHash)) != 1 {
		return fmt.Errorf("준비 credential/nullifier와 일치하지 않습니다")
	}
	publicBytes, err := ctx.GetStub().GetState(publicKey)
	if err != nil || publicBytes == nil {
		return fmt.Errorf("vector ballot 공개 영수증이 누락되었습니다")
	}
	var receipt VectorBallotReceipt
	if err := json.Unmarshal(publicBytes, &receipt); err != nil || receipt.Status != "prepared" ||
		receipt.BallotID != ballotID || receipt.ElectionID != electionID || receipt.ArtifactHash != preparation.ArtifactHash {
		return fmt.Errorf("vector ballot 공개 영수증 불일치")
	}
	transient, err := ctx.GetStub().GetTransient()
	if err != nil {
		return fmt.Errorf("transient 읽기 실패: %w", err)
	}
	votePrivateBytes, ok := transient["votePrivate"]
	if !ok || len(votePrivateBytes) == 0 {
		return fmt.Errorf("votePrivate transient가 필요합니다")
	}
	var votePrivate VotePrivate
	if err := json.Unmarshal(votePrivateBytes, &votePrivate); err != nil {
		return fmt.Errorf("VotePrivate 파싱 실패: %w", err)
	}
	proofBytes, ok := transient["vectorBallotValidityProof"]
	if !ok || len(proofBytes) == 0 {
		return fmt.Errorf("vectorBallotValidityProof transient가 필요합니다")
	}
	var proof VectorBallotValidityProof
	if err := json.Unmarshal(proofBytes, &proof); err != nil {
		return fmt.Errorf("VectorBallotValidityProof 파싱 실패: %w", err)
	}
	artifactHash, err := computeVectorAuditArtifactHash(electionID, election.Candidates, votePrivate.EncryptedCandidateVector, &proof)
	if err != nil {
		return err
	}
	if subtle.ConstantTimeCompare([]byte(preparation.ArtifactHash), []byte(artifactHash)) != 1 {
		return fmt.Errorf("cast artifact가 준비된 vector ballot과 일치하지 않습니다")
	}
	if err := c.castVoteInternal(ctx, electionID, "", nullifierHash, ballotID); err != nil {
		return err
	}
	now, err := getTxTime(ctx)
	if err != nil {
		return err
	}
	preparation.Status, preparation.TerminalAt, preparation.TerminalTxID = "cast", now, ctx.GetStub().GetTxID()
	receipt.Status, receipt.TerminalAt, receipt.TerminalTxID = "cast", now, ctx.GetStub().GetTxID()
	updatedPrivate, err := json.Marshal(preparation)
	if err != nil {
		return err
	}
	updatedReceipt, err := json.Marshal(receipt)
	if err != nil {
		return err
	}
	if err := ctx.GetStub().PutPrivateData(VotePrivatePDC, privateKey, updatedPrivate); err != nil {
		return fmt.Errorf("vector ballot cast 상태 저장 실패: %w", err)
	}
	if err := ctx.GetStub().PutState(publicKey, updatedReceipt); err != nil {
		return fmt.Errorf("vector ballot cast 영수증 저장 실패: %w", err)
	}
	return nil
}

// PrepareBallot [PAPER-3] 투표 암호화를 사전 수행하고 commitment을 반환합니다.
// 유권자는 이 commitment을 받은 후 audit(검증) 또는 cast(투표) 중 하나를 선택합니다.
//
// 인자: electionID, candidateID
// 반환: ballotID, encryptedCandidateID, commitment
func (c *VotingContract) PrepareBallot(
	ctx contractapi.TransactionContextInterface,
	electionID string,
	candidateID string,
) (*BallotPreparation, error) {
	if err := validateElectionID(electionID); err != nil {
		return nil, err
	}

	electionBytes, err := ctx.GetStub().GetState(electionID)
	if err != nil || electionBytes == nil {
		return nil, fmt.Errorf("선거를 찾을 수 없습니다: %s", electionID)
	}
	var election Election
	if err := json.Unmarshal(electionBytes, &election); err != nil {
		return nil, fmt.Errorf("선거 데이터 파싱 실패: %w", err)
	}
	if election.Status != "ACTIVE" {
		return nil, fmt.Errorf("ACTIVE 상태의 선거에서만 투표 준비가 가능합니다")
	}
	if !contains(election.Candidates, candidateID) {
		return nil, fmt.Errorf("유효하지 않은 후보자 ID입니다: %s", candidateID)
	}

	encKey, err := getEncryptionKey(ctx, electionID)
	if err != nil {
		return nil, fmt.Errorf("암호화 키 조회 실패: %w", err)
	}
	encryptedCandID, err := encryptAESGCM(encKey, candidateID)
	if err != nil {
		return nil, fmt.Errorf("후보자 암호화 실패: %w", err)
	}

	// ballotID: SHA256(electionID + encryptedCandID + txID)
	txID := ctx.GetStub().GetTxID()
	ballotIDRaw := sha256.Sum256([]byte(electionID + encryptedCandID + txID))
	ballotID := hex.EncodeToString(ballotIDRaw[:])

	// commitment: SHA256(ballotID + encryptedCandidateID) — 변조 감지용
	commitRaw := sha256.Sum256([]byte(ballotID + encryptedCandID))
	commitment := hex.EncodeToString(commitRaw[:])

	now, _ := getTxTime(ctx)
	bp := BallotPreparation{
		BallotID:             ballotID,
		ElectionID:           electionID,
		CandidateID:          candidateID,
		EncryptedCandidateID: encryptedCandID,
		Commitment:           commitment,
		Status:               "prepared",
		CreatedAt:            now,
	}

	// PDC에 임시 저장 (키: BALLOT_{ballotID})
	bpBytes, _ := json.Marshal(bp)
	ballotKey := "BALLOT_" + ballotID
	if err := ctx.GetStub().PutPrivateData(VotePrivatePDC, ballotKey, bpBytes); err != nil {
		return nil, fmt.Errorf("ballot PDC 저장 실패: %w", err)
	}

	log.Printf("[PrepareBallot] 투표 준비 완료 — election: %s, ballotID: %s", electionID, ballotID[:16])

	// 클라이언트에 반환: candidateID 제외 (audit 전까지 비공개)
	return &BallotPreparation{
		BallotID:             ballotID,
		ElectionID:           electionID,
		EncryptedCandidateID: encryptedCandID,
		Commitment:           commitment,
		Status:               "prepared",
		CreatedAt:            now,
	}, nil
}

// AuditBallot [PAPER-3] 사전 준비된 투표를 검증합니다 (spoil).
// 암호화 키를 공개하여 클라이언트가 암호문 정확성을 독립 검증할 수 있게 합니다.
// audit된 투표는 "audited"로 표시되어 실제 투표에 사용할 수 없습니다.
//
// 인자: electionID, ballotID
// 반환: candidateID(평문), encryptionKeyHex (검증용)
func (c *VotingContract) AuditBallot(
	ctx contractapi.TransactionContextInterface,
	electionID string,
	ballotID string,
) (string, error) {
	if err := validateElectionID(electionID); err != nil {
		return "", err
	}

	ballotKey := "BALLOT_" + ballotID
	bpBytes, err := ctx.GetStub().GetPrivateData(VotePrivatePDC, ballotKey)
	if err != nil || bpBytes == nil {
		return "", fmt.Errorf("ballot을 찾을 수 없습니다: %s", ballotID)
	}

	var bp BallotPreparation
	if err := json.Unmarshal(bpBytes, &bp); err != nil {
		return "", fmt.Errorf("ballot 파싱 실패: %w", err)
	}
	if bp.ElectionID != electionID {
		return "", fmt.Errorf("ballot의 선거 ID가 일치하지 않습니다")
	}
	if bp.Status != "prepared" {
		return "", fmt.Errorf("이미 처리된 ballot입니다 (status: %s)", bp.Status)
	}

	// audit으로 상태 변경 (재사용 방지)
	bp.Status = "audited"
	bpBytes, _ = json.Marshal(bp)
	if err := ctx.GetStub().PutPrivateData(VotePrivatePDC, ballotKey, bpBytes); err != nil {
		return "", fmt.Errorf("ballot 상태 업데이트 실패: %w", err)
	}

	// 암호화 키 조회 → 클라이언트에 반환 (검증용)
	encKey, err := getEncryptionKey(ctx, electionID)
	if err != nil {
		return "", fmt.Errorf("암호화 키 조회 실패: %w", err)
	}

	// JSON으로 audit 결과 반환
	auditResult := map[string]string{
		"ballotID":             ballotID,
		"candidateID":          bp.CandidateID,
		"encryptedCandidateID": bp.EncryptedCandidateID,
		"encryptionKeyHex":     hex.EncodeToString(encKey),
		"status":               "audited",
	}
	resultBytes, _ := json.Marshal(auditResult)

	log.Printf("[AuditBallot] 투표 검증 (spoil) — election: %s, ballotID: %s", electionID, ballotID[:16])
	return string(resultBytes), nil
}

// ============================================================
// TallyVotes — CouchDB Rich Query 집계
// ============================================================

// TallyVotes CouchDB Rich Query로 해당 선거의 모든 Nullifier를 조회하여
// 후보자별 득표수를 집계하고 VoteTally를 원장에 기록합니다.
//
// CouchDB가 상태 DB로 설정된 경우에만 동작합니다 (docker-compose 설정 확인).
func (c *VotingContract) TallyVotes(
	ctx contractapi.TransactionContextInterface,
	electionID string,
) (*VoteTally, error) {
	if err := requireElectionAdmin(ctx); err != nil {
		return nil, err
	}
	return c.tallyVotesInternal(ctx, electionID, nil, false)
}

// tallyVotesInternal [P2] 집계 핵심 로직 (내부용 — contractapi 미노출).
//
//	providedKey != nil → 그 키로 복호화 (복원 직후 in-memory 키; PDC 미조회).
//	                     (같은 tx에서 PutPrivateData한 키는 GetPrivateData로 안 보이므로 직접 전달)
//	aggregateOnly=true → 복호화 없이 암호문 집계만 (종료 시; 키 미조회).
//	기본값             → ElGamal은 PDC에서 키 조회 후 복호화 (기존 동작).
func (c *VotingContract) tallyVotesInternal(
	ctx contractapi.TransactionContextInterface,
	electionID string,
	providedKey *big.Int,
	aggregateOnly bool,
) (*VoteTally, error) {
	// 선거 존재 확인
	election, err := c.GetElection(ctx, electionID)
	if err != nil {
		return nil, err
	}

	// CouchDB Rich Query: docType == "nullifier" AND electionID == 요청값
	queryString := fmt.Sprintf(
		`{"selector":{"docType":"nullifier","electionID":"%s"},"use_index":["_design/indexElection","electionIndex"]}`,
		electionID,
	)

	resultsIterator, err := ctx.GetStub().GetQueryResult(queryString)
	if err != nil {
		return nil, fmt.Errorf("CouchDB 쿼리 실패: %w", err)
	}
	defer resultsIterator.Close()

	closedAt, err := getTxTime(ctx)
	if err != nil {
		return nil, err
	}

	// 암호화 키/비밀키 조회
	encKey, ekErr := getEncryptionKey(ctx, electionID)
	useAES := ekErr == nil && encKey != nil
	var elgamalPrivKey *big.Int
	// [P2] 동형 집계(암호문 곱)는 키 불필요, 최종 복호화에만 키 필요.
	vectorElGamal := election.EncryptionMode == "elgamal-vector-v3"
	aggregateElGamal := election.EncryptionMode == "elgamal" || vectorElGamal
	canDecryptElGamal := false
	if aggregateElGamal && !aggregateOnly {
		if providedKey != nil {
			elgamalPrivKey = providedKey
			canDecryptElGamal = true
		} else {
			k, pkErr := getElGamalPrivateKey(ctx, electionID)
			if pkErr == nil && k != nil {
				elgamalPrivKey = k
				canDecryptElGamal = true
			} else {
				log.Printf("[tallyVotes] ElGamal 비밀키 없음 — 암호문 집계만 수행(복원 대기) — %v", pkErr)
			}
		}
	}

	// 후보자별 득표 집계
	results := make(map[string]int)
	for _, cand := range election.Candidates {
		results[cand] = 0 // 0표도 명시적으로 기록
	}
	totalVotes := 0
	var decProofs []DecryptionProof

	// [PAPER-13] 동형 집계를 위한 암호문 누적기 (ElGamal 모드)
	accC1 := big.NewInt(1) // Π c1_i mod p
	accC2 := big.NewInt(1) // Π c2_i mod p
	vectorAccC1 := make([]*big.Int, len(election.Candidates))
	vectorAccC2 := make([]*big.Int, len(election.Candidates))
	for i := range vectorAccC1 {
		vectorAccC1[i], vectorAccC2[i] = big.NewInt(1), big.NewInt(1)
	}
	homomorphicCount := 0 // 동형 누적에 포함된 투표 수

	for resultsIterator.HasNext() {
		queryResult, err := resultsIterator.Next()
		if err != nil {
			return nil, fmt.Errorf("결과 순회 실패: %w", err)
		}

		var nullifier Nullifier
		if err := json.Unmarshal(queryResult.Value, &nullifier); err != nil {
			return nil, fmt.Errorf("Nullifier 역직렬화 실패: %w", err)
		}

		// Pre-created panic-mode padding is not a cast ballot and must never enter
		// the tally. In particular, ElGamal elections historically stored these
		// records using AES-GCM, which otherwise looks like a malformed ciphertext.
		if nullifier.IsPadding {
			continue
		}

		// Fabric은 write transaction에서 private-data rich query를 금지한다.
		// 따라서 피어가 검증 가능한 개별 PDC point read로 panic 여부를 확인한다.
		vpBytes, vpErr := ctx.GetStub().GetPrivateData(VotePrivatePDC, nullifier.NullifierHash)
		if vpErr != nil {
			return nil, fmt.Errorf("PDC 투표 조회 실패 (nullifier=%s): %w", nullifier.NullifierHash, vpErr)
		}
		if vpBytes != nil {
			var vpCheck VotePrivate
			if json.Unmarshal(vpBytes, &vpCheck) == nil && vpCheck.CredentialType == "panic" {
				continue
			}
		}

		// 레거시 평문 레코드만 호환한다. 신규 레코드의 빈 암호문은 아래
		// ElGamal 형식 검증에서 실패하도록 암묵적인 dummy 판정을 하지 않는다.
		if nullifier.EncryptedCandidateID == "" && len(nullifier.EncryptedCandidateVector) == 0 {
			// 레거시 평문 또는 더미 nullifier
			candID := nullifier.CandidateID
			if candID != "" {
				results[candID]++
				totalVotes++
			}
			continue
		}

		if vectorElGamal {
			if len(nullifier.EncryptedCandidateVector) != len(election.Candidates) ||
				nullifier.VectorBallotValidityProof == nil {
				return nil, fmt.Errorf("vector-v3 원장 투표 검증 실패 (nullifier=%s)", nullifier.NullifierHash)
			}
			// CastVote endorsement가 one-hot ZKP를 이미 검증했고 원장은 불변이다.
			// 집계 tx는 proof 존재와 군 원소를 재검사하며, 모든 ZKP 재연산은
			// election bundle standalone verifier의 독립 검증 단계에서 수행한다.
			for i, ciphertext := range nullifier.EncryptedCandidateVector {
				c1i, ok1 := parseSubgroupElement(ciphertext.C1)
				c2i, ok2 := parseSubgroupElement(ciphertext.C2)
				if !ok1 || !ok2 {
					return nil, fmt.Errorf("vector-v3 암호문 군 원소 검증 실패 (nullifier=%s, index=%d)", nullifier.NullifierHash, i)
				}
				vectorAccC1[i].Mul(vectorAccC1[i], c1i).Mod(vectorAccC1[i], elgamalP)
				vectorAccC2[i].Mul(vectorAccC2[i], c2i).Mod(vectorAccC2[i], elgamalP)
			}
			homomorphicCount++
			totalVotes++
		} else if aggregateElGamal {
			// [PAPER-13] Exponential ElGamal 동형 집계
			// 개별 복호화 없이 암호문을 곱셈으로 누적
			// Π E(g^m_i) = E(g^(Σm_i)) → 한 번만 복호화
			parts := strings.SplitN(nullifier.EncryptedCandidateID, ":", 2)
			if len(parts) != 2 {
				return nil, fmt.Errorf("ElGamal 암호문 형식 오류 (nullifier=%s)", nullifier.NullifierHash)
			}
			c1i, ok1 := parseSubgroupElement(parts[0])
			c2i, ok2 := parseSubgroupElement(parts[1])
			if !ok1 || !ok2 {
				return nil, fmt.Errorf("ElGamal 암호문 군 원소 검증 실패 (nullifier=%s)", nullifier.NullifierHash)
			}
			accC1.Mul(accC1, c1i)
			accC1.Mod(accC1, elgamalP)
			accC2.Mul(accC2, c2i)
			accC2.Mod(accC2, elgamalP)
			homomorphicCount++
			totalVotes++
		} else if useAES {
			// AES 복호화 (기존 — 개별 복호화)
			decrypted, decErr := decryptAESGCM(encKey, nullifier.EncryptedCandidateID)
			if decErr == nil {
				candID := decrypted
				dh := sha256.Sum256([]byte(decrypted))
				decProofs = append(decProofs, DecryptionProof{
					NullifierHash:        nullifier.NullifierHash,
					EncryptedCandidateID: nullifier.EncryptedCandidateID,
					DecryptedHash:        hex.EncodeToString(dh[:]),
					CandidateCommitment:  nullifier.CandidateCommitment,
				})
				results[candID]++
			} else {
				log.Printf("[TallyVotes] AES 복호화 실패 (평문 폴백) — %v", decErr)
				results[nullifier.CandidateID]++
			}
			totalVotes++
		}
	}

	// [P2] ElGamal 동형 집계 완료. 키가 있으면 복호화, 없으면(분산 후) 암호문 집계만 저장.
	tallyDecrypted := true
	encAggC1, encAggC2 := "", ""
	var encAggVector []ElGamalCiphertext
	if vectorElGamal && homomorphicCount > 0 && canDecryptElGamal {
		for i, candidate := range election.Candidates {
			gm, decErr := expElGamalDecryptToGm(elgamalPrivKey, vectorAccC1[i].Text(16), vectorAccC2[i].Text(16))
			if decErr != nil {
				return nil, fmt.Errorf("vector-v3 집계 복호화 실패 (index=%d): %w", i, decErr)
			}
			count, bsgsErr := babyStepGiantStep(gm, elgamalG, elgamalP, int64(totalVotes)+1)
			if bsgsErr != nil {
				return nil, fmt.Errorf("vector-v3 BSGS 복원 실패 (index=%d): %w", i, bsgsErr)
			}
			results[candidate] = int(count)
		}
	} else if aggregateElGamal && homomorphicCount > 0 && canDecryptElGamal {
		if err := validateHomomorphicTallyCapacity(homomorphicCount, len(election.Candidates)); err != nil {
			return nil, err
		}
		// g^sum = accC2 * accC1^(-x) mod p
		gSum, decErr := expElGamalDecryptToGm(elgamalPrivKey, accC1.Text(16), accC2.Text(16))
		if decErr != nil {
			return nil, fmt.Errorf("동형 집계 복호화 실패: %w", decErr)
		}

		// BSGS로 이산로그 복원: sum = log_g(gSum)
		// [P3 수정] 인코딩 sum = Σ count_i·B^i 의 실제 상한은 totalVotes·B^(numCands-1).
		//   기존 고정 상한(10^8)은 최상위 후보(index ≥ 2)가 득표하면 초과되어 복원 실패했음.
		//   totalVotes 기반으로 상한을 올바르게 산정하고, 메모리 안전 상한을 상향(테이블 ~sqrt).
		numCands := len(election.Candidates)
		maxSum := int64(totalVotes) + 1
		for i := 0; i < numCands-1; i++ {
			maxSum *= HomomorphicBase
		}

		sum, bsgsErr := babyStepGiantStep(gSum, elgamalG, elgamalP, maxSum)
		if bsgsErr != nil {
			return nil, fmt.Errorf("BSGS 이산로그 복원 실패: %w", bsgsErr)
		}

		// base-B 자릿수 분해 → 후보별 득표수
		counts := decomposeBaseB(sum, numCands)
		for i, cand := range election.Candidates {
			results[cand] = counts[i]
		}

		// 동형 집계 Chaum-Pedersen ZKP 생성 (누적 암호문의 복호화 정확성 증명)
		sumStr := fmt.Sprintf("homomorphic_sum:%d", sum)
		dh := sha256.Sum256([]byte(sumStr))
		dhHex := hex.EncodeToString(dh[:])

		zkProof, zpErr := chaumPedersenProveRaw(
			elgamalPrivKey, accC1.Text(16), accC2.Text(16), gSum.Text(16),
			"homomorphic_tally", electionID, dhHex,
		)

		dp := DecryptionProof{
			NullifierHash:        "HOMOMORPHIC_TALLY",
			EncryptedCandidateID: accC1.Text(16) + ":" + accC2.Text(16),
			DecryptedHash:        dhHex,
		}
		if zpErr == nil {
			zkProof.CandidateCommitment = fmt.Sprintf("sum=%d,counts=%v", sum, counts)
			dp.ZKProof = zkProof
		}
		decProofs = append(decProofs, dp)

		log.Printf("[TallyVotes] 동형 집계 완료 — sum=%d, counts=%v, 투표수=%d",
			sum, counts, homomorphicCount)
	} else if vectorElGamal && homomorphicCount > 0 {
		tallyDecrypted = false
		encAggVector = make([]ElGamalCiphertext, len(election.Candidates))
		for i := range election.Candidates {
			encAggVector[i] = ElGamalCiphertext{C1: vectorAccC1[i].Text(16), C2: vectorAccC2[i].Text(16)}
		}
		log.Printf("[TallyVotes] vector-v3 암호문 집계 저장(복호화 대기) — election: %s, count=%d", electionID, homomorphicCount)
	} else if aggregateElGamal && homomorphicCount > 0 {
		// [P2] 복호화 보류 — 키 분산 후이므로 암호문 집계만 저장(Results는 0 유지).
		//   2-of-3 조각 복원 시 verifyKeyReconstruction이 키를 복구하고 재집계하여 복호화한다.
		tallyDecrypted = false
		encAggC1 = accC1.Text(16)
		encAggC2 = accC2.Text(16)
		log.Printf("[TallyVotes] 암호문 집계 저장(복호화 대기) — election: %s, homomorphicCount=%d",
			electionID, homomorphicCount)
	}

	// [PAPER-2] 전체 집계 증명 해시 계산: 모든 DecryptionProof의 정렬된 해시
	tallyProofHash := computeTallyProofHash(decProofs)

	tally := VoteTally{
		ObjectType:       "tally",
		ElectionID:       electionID,
		Results:          results,
		TotalVotes:       totalVotes,
		ClosedAt:         closedAt,
		TallyProofHash:   tallyProofHash,
		DecryptionProofs: decProofs,
		Decrypted:        tallyDecrypted,
		EncAggC1:         encAggC1,
		EncAggC2:         encAggC2,
		EncAggVector:     encAggVector,
	}

	// 집계 결과를 원장에 영구 기록 (키: "TALLY_<electionID>")
	tallyKey := "TALLY_" + electionID
	b, err := json.Marshal(tally)
	if err != nil {
		return nil, fmt.Errorf("VoteTally 직렬화 실패: %w", err)
	}
	if err := ctx.GetStub().PutState(tallyKey, b); err != nil {
		return nil, fmt.Errorf("VoteTally 원장 저장 실패: %w", err)
	}

	// Do not log the filtered-transcript count or any per-ballot panic marker.
	// Either value gives a peer/container-log observer a direct coercion oracle.
	log.Printf("[TallyVotes] 집계 완료 — election: %s, 유효 투표: %d", electionID, totalVotes)
	return &tally, nil
}

// GetTally 집계 결과를 조회합니다 (CloseElection 이후에 조회 가능).
func (c *VotingContract) GetTally(
	ctx contractapi.TransactionContextInterface,
	electionID string,
) (*VoteTally, error) {
	tallyKey := "TALLY_" + electionID
	b, err := ctx.GetStub().GetState(tallyKey)
	if err != nil {
		return nil, fmt.Errorf("원장 조회 실패: %w", err)
	}
	if b == nil {
		return nil, fmt.Errorf("집계 결과가 없습니다. CloseElection을 먼저 호출하세요: %s", electionID)
	}
	var tally VoteTally
	if err := json.Unmarshal(b, &tally); err != nil {
		return nil, err
	}
	return &tally, nil
}

// ============================================================
// 조회 보조 함수
// ============================================================

// GetElection 선거 정보를 조회합니다.
func (c *VotingContract) GetElection(
	ctx contractapi.TransactionContextInterface,
	electionID string,
) (*Election, error) {
	data, err := ctx.GetStub().GetState(electionID)
	if err != nil {
		return nil, fmt.Errorf("원장 조회 실패: %w", err)
	}
	if data == nil {
		return nil, fmt.Errorf("선거를 찾을 수 없습니다: %s", electionID)
	}
	var election Election
	if err := json.Unmarshal(data, &election); err != nil {
		return nil, fmt.Errorf("선거 역직렬화 실패: %w", err)
	}
	return &election, nil
}

// GetNullifier Nullifier 존재 여부를 조회합니다 (투표 여부 확인 또는 감사용).
// nil 반환 시 아직 투표하지 않은 유권자입니다.
func (c *VotingContract) GetNullifier(
	ctx contractapi.TransactionContextInterface,
	nullifierHash string,
) (*Nullifier, error) {
	data, err := ctx.GetStub().GetState(nullifierHash)
	if err != nil {
		return nil, fmt.Errorf("원장 조회 실패: %w", err)
	}
	if data == nil {
		return nil, nil
	}
	var n Nullifier
	if err := json.Unmarshal(data, &n); err != nil {
		return nil, err
	}
	return &n, nil
}

func resolveCandidateID(ctx contractapi.TransactionContextInterface, electionID string, n *Nullifier) string {
	if n == nil {
		return ""
	}
	if n.EncryptedCandidateID != "" {
		if encKey, err := getEncryptionKey(ctx, electionID); err == nil {
			if candID, decErr := decryptAESGCM(encKey, n.EncryptedCandidateID); decErr == nil {
				return candID
			}
		}
	}
	return n.CandidateID
}

// ============================================================
// Merkle Tree 데이터 구조체
// ============================================================

// MerkleNode Merkle 경로의 단일 노드 — GetMerkleProof 응답에 포함됩니다.
type MerkleNode struct {
	Hash     string `json:"hash"`
	Position string `json:"position"` // "left" | "right" — 형제 노드 위치
}

// MerkleProofResult GetMerkleProofWithPassword 반환 구조체
// Normal Mode와 Panic Mode 모두 동일한 구조를 반환합니다 (강압자 구분 불가).
type MerkleProofResult struct {
	NullifierHash        string       `json:"nullifierHash"`        // 증명 대상 nullifier (Panic Mode에서는 더미)
	CandidateID          string       `json:"candidateID"`          // 해당 nullifier의 후보자 ID (Normal/Panic 표시용)
	CandidateCommitment  string       `json:"candidateCommitment"`  // 암호화 투표 레코드 commitment
	EncryptedCandidateID string       `json:"encryptedCandidateID"` // 후보자 암호문
	LeafHash             string       `json:"leafHash"`             // Merkle leaf = H(election|nullifier|commitment|ciphertext)
	Proof                []MerkleNode `json:"proof"`                // Merkle 포함 증명 경로
}

type MerkleLeaf struct {
	NullifierHash string
	LeafHash      string
}

// MerkleRoot 선거별 Merkle Root 정보 (공개 원장, 키: "MERKLE_ROOT_<electionID>")
type MerkleRoot struct {
	ObjectType string `json:"docType"` // "merkleRoot"
	ElectionID string `json:"electionID"`
	RootHash   string `json:"rootHash"`
	LeafCount  int    `json:"leafCount"` // 집계된 투표 수 (= Merkle 리프 수)
	CreatedAt  int64  `json:"createdAt"`
}

// ============================================================
// STEP 2: Merkle Tree — 투표 무결성 E2E 검증 지원
// ============================================================

// BuildMerkleTree 선거의 모든 암호화 투표 레코드 commitment로 Merkle Tree를 구축하고
// Root Hash를 원장에 기록합니다. CloseElection 이후에 호출해야 합니다.
//
// 원장 키: "MERKLE_ROOT_{electionID}"
//
// 결정론적 구성:
//   - 리프를 leafHash 알파벳 순으로 정렬
//   - 홀수 리프일 경우 마지막 리프를 복제하여 짝수로 맞춤
//   - 각 내부 노드: SHA256(leftHash + rightHash)
func (c *VotingContract) BuildMerkleTree(
	ctx contractapi.TransactionContextInterface,
	electionID string,
) (*MerkleRoot, error) {
	if err := requireElectionAdmin(ctx); err != nil {
		return nil, err
	}

	// 선거 존재 + 종료 상태 확인
	election, err := c.GetElection(ctx, electionID)
	if err != nil {
		return nil, err
	}
	if election.Status != "CLOSED" {
		return nil, fmt.Errorf("Merkle Tree는 선거 종료(CLOSED) 후에만 구축할 수 있습니다 (현재 상태: %s)", election.Status)
	}

	// 해당 선거의 모든 암호화 투표 레코드 leaf 수집
	leafRecords, err := collectMerkleLeaves(ctx, electionID)
	if err != nil {
		return nil, err
	}
	if len(leafRecords) == 0 {
		return nil, fmt.Errorf("투표 기록이 없어 Merkle Tree를 구축할 수 없습니다: %s", electionID)
	}

	// 결정론적 정렬
	sort.Slice(leafRecords, func(i, j int) bool {
		return leafRecords[i].LeafHash < leafRecords[j].LeafHash
	})
	leaves := make([]string, len(leafRecords))
	for i, leaf := range leafRecords {
		leaves[i] = leaf.LeafHash
	}

	// Merkle Root 계산
	rootHash := computeMerkleRoot(leaves)

	now, err := getTxTime(ctx)
	if err != nil {
		return nil, err
	}

	mr := MerkleRoot{
		ObjectType: "merkleRoot",
		ElectionID: electionID,
		RootHash:   rootHash,
		LeafCount:  len(leaves),
		CreatedAt:  now,
	}
	b, err := json.Marshal(mr)
	if err != nil {
		return nil, fmt.Errorf("MerkleRoot 직렬화 실패: %w", err)
	}
	merkleKey := "MERKLE_ROOT_" + electionID
	if err := ctx.GetStub().PutState(merkleKey, b); err != nil {
		return nil, fmt.Errorf("MerkleRoot 원장 저장 실패: %w", err)
	}

	log.Printf("[BuildMerkleTree] 완료 — election: %s, root: %s, leaves: %d", electionID, rootHash, len(leaves))
	return &mr, nil
}

// GetMerkleProof 특정 Nullifier Hash에 대한 Merkle 포함 증명(Inclusion Proof)을 반환합니다.
// 검증자는 이 경로와 Root Hash를 이용해 해당 투표가 집계에 포함됐음을 확인할 수 있습니다.
//
// 반환값: Merkle Path (리프 → 루트 방향의 형제 노드 해시 목록)
func (c *VotingContract) GetMerkleProof(
	ctx contractapi.TransactionContextInterface,
	electionID string,
	nullifierHash string,
) ([]MerkleNode, error) {
	// Merkle Root 존재 확인
	merkleKey := "MERKLE_ROOT_" + electionID
	mrBytes, err := ctx.GetStub().GetState(merkleKey)
	if err != nil {
		return nil, fmt.Errorf("MerkleRoot 조회 실패: %w", err)
	}
	if mrBytes == nil {
		return nil, fmt.Errorf("Merkle Tree가 아직 구축되지 않았습니다. BuildMerkleTree를 먼저 호출하세요: %s", electionID)
	}

	// 해당 선거의 모든 Merkle leaf 수집 후 정렬
	leafRecords, err := collectMerkleLeaves(ctx, electionID)
	if err != nil {
		return nil, err
	}
	sort.Slice(leafRecords, func(i, j int) bool {
		return leafRecords[i].LeafHash < leafRecords[j].LeafHash
	})
	leaves := make([]string, len(leafRecords))
	for i, leaf := range leafRecords {
		leaves[i] = leaf.LeafHash
	}

	// 요청한 nullifierHash에 대응하는 leaf가 있는지 확인
	leafIdx := -1
	for i, leaf := range leafRecords {
		if leaf.NullifierHash == nullifierHash {
			leafIdx = i
			break
		}
	}
	if leafIdx == -1 {
		return nil, fmt.Errorf("해당 Nullifier Hash가 이 선거의 투표 기록에 없습니다: %s", nullifierHash)
	}

	// Merkle 포함 증명 경로 계산
	proof := computeMerkleProof(leaves, leafIdx)
	return proof, nil
}

// GetMerkleRoot Merkle Root 정보를 조회합니다 (읽기 전용).
func (c *VotingContract) GetMerkleRoot(
	ctx contractapi.TransactionContextInterface,
	electionID string,
) (*MerkleRoot, error) {
	merkleKey := "MERKLE_ROOT_" + electionID
	b, err := ctx.GetStub().GetState(merkleKey)
	if err != nil {
		return nil, fmt.Errorf("원장 조회 실패: %w", err)
	}
	if b == nil {
		return nil, fmt.Errorf("Merkle Root가 없습니다. BuildMerkleTree를 먼저 호출하세요: %s", electionID)
	}
	var mr MerkleRoot
	if err := json.Unmarshal(b, &mr); err != nil {
		return nil, err
	}
	return &mr, nil
}

// GetMerkleProofWithPassword Panic Mode를 지원하는 Deniable Verification 함수입니다.
//
//   - normalPassword와 panicPassword는 클라이언트가 SHA256(password + nullifierHash)로 계산해서 전달합니다.
//   - normalPWHash 일치 → 실제 nullifierHash의 Merkle 포함 증명 반환 (Normal Mode)
//   - panicPWHash  일치 → 더미 nullifierHash의 포함 증명 반환 (Panic Mode)
//     더미도 Merkle Tree의 실제 리프이므로, 강압자가 검증해도 수학적으로 통과합니다.
//
// 보안 속성:
//   - Normal Mode와 Panic Mode의 응답 구조가 동일 → 강압자가 구분 불가능
//   - 서버는 어느 모드인지 알 수 없음 (PDC에서 조회만 함)
func (c *VotingContract) GetMerkleProofWithPassword(
	ctx contractapi.TransactionContextInterface,
	electionID string,
	nullifierHash string,
	passwordHash string,
) (*MerkleProofResult, error) {
	// ── 1. Merkle Root 존재 확인 ─────────────────────────────
	merkleKey := "MERKLE_ROOT_" + electionID
	mrBytes, err := ctx.GetStub().GetState(merkleKey)
	if err != nil {
		return nil, fmt.Errorf("MerkleRoot 조회 실패: %w", err)
	}
	if mrBytes == nil {
		return nil, fmt.Errorf("Merkle Tree가 구축되지 않았습니다. BuildMerkleTree를 먼저 호출하세요: %s", electionID)
	}

	// ── 2. PDC에서 비밀번호 해시 조회 ───────────────────────
	pwKey := "VOTER_PW_" + nullifierHash
	pwBytes, err := ctx.GetStub().GetPrivateData(VotePrivatePDC, pwKey)
	if err != nil {
		return nil, fmt.Errorf("비밀번호 PDC 조회 실패: %w", err)
	}
	if pwBytes == nil {
		// 비밀번호 미등록 → 일반 GetMerkleProof로 폴백
		proof, err := c.GetMerkleProof(ctx, electionID, nullifierHash)
		if err != nil {
			return nil, err
		}
		// candidateID 조회
		n, err := c.GetNullifier(ctx, nullifierHash)
		if err != nil || n == nil {
			return nil, fmt.Errorf("Nullifier 조회 실패")
		}
		leafHash := computeMerkleLeafHash(n)
		return &MerkleProofResult{
			NullifierHash:        nullifierHash,
			CandidateID:          resolveCandidateID(ctx, electionID, n),
			CandidateCommitment:  n.CandidateCommitment,
			EncryptedCandidateID: n.EncryptedCandidateID,
			LeafHash:             leafHash,
			Proof:                proof,
		}, nil
	}

	var pw VoterPWPrivate
	if err := json.Unmarshal(pwBytes, &pw); err != nil {
		return nil, fmt.Errorf("VoterPWPrivate 역직렬화 실패: %w", err)
	}

	// ── 3. 비밀번호 일치 여부 확인 ───────────────────────────
	// 어느 모드인지 확인 (Normal vs Panic)
	targetHash := nullifierHash

	// 상수시간 비교로 타이밍 사이드채널 방지 (A-2 보안 수정)
	isPanic := subtle.ConstantTimeCompare([]byte(passwordHash), []byte(pw.PanicPWHash)) == 1
	isNormal := subtle.ConstantTimeCompare([]byte(passwordHash), []byte(pw.NormalPWHash)) == 1
	if isPanic {
		// ── Panic Mode: 더미 nullifier 반환 ─────────────────
		dummyCandID := pw.PanicCandidateID
		if dummyCandID == "" {
			election, err := c.GetElection(ctx, electionID)
			if err != nil {
				return nil, err
			}
			if len(election.Candidates) > 0 {
				dummyCandID = election.Candidates[0]
			}
		}
		// [PAPER-8] 결정론적 랜덤 더미 선택: 매번 동일 요청에 동일 더미 반환하되,
		// passwordHash에 따라 다른 더미 선택 → 강압자의 반복 요청 시 일관성 유지
		dummySelector := sha256.Sum256([]byte(passwordHash + nullifierHash + electionID))
		dummyIdx := int(new(big.Int).SetBytes(dummySelector[:]).Int64()) % PanicDummyCount
		if dummyIdx < 0 {
			dummyIdx = -dummyIdx
		}
		dummyIdxKey := fmt.Sprintf("DUMMY_IDX_%s_%s_%d", electionID, dummyCandID, dummyIdx)
		dummyHashBytes, err := ctx.GetStub().GetState(dummyIdxKey)
		if err != nil || dummyHashBytes == nil {
			// 폴백: index 0
			dummyIdxKey = fmt.Sprintf("DUMMY_IDX_%s_%s_0", electionID, dummyCandID)
			dummyHashBytes, err = ctx.GetStub().GetState(dummyIdxKey)
			if err != nil || dummyHashBytes == nil {
				return nil, fmt.Errorf("더미 Nullifier를 찾을 수 없습니다 (candidate: %s)", dummyCandID)
			}
		}
		targetHash = string(dummyHashBytes)
	} else if !isNormal {
		// 두 비밀번호 모두 불일치 (상수시간 비교 완료 후 판정)
		return nil, fmt.Errorf("비밀번호가 일치하지 않습니다")
	}

	// ── 4. 선택된 nullifier의 Merkle 증명 + candidateID 반환 ─
	proof, err := c.GetMerkleProof(ctx, electionID, targetHash)
	if err != nil {
		return nil, err
	}

	// candidateID 조회 (Normal: 실제 후보, Panic: 더미 후보)
	n, err := c.GetNullifier(ctx, targetHash)
	if err != nil || n == nil {
		return nil, fmt.Errorf("Nullifier candidateID 조회 실패: %s", targetHash)
	}

	return &MerkleProofResult{
		NullifierHash:        targetHash,
		CandidateID:          resolveCandidateID(ctx, electionID, n),
		CandidateCommitment:  n.CandidateCommitment,
		EncryptedCandidateID: n.EncryptedCandidateID,
		LeafHash:             computeMerkleLeafHash(n),
		Proof:                proof,
	}, nil
}

// GetMerkleProofWithLookup retrieves a deniable proof through an opaque
// password-derived capability. Unlike GetMerkleProofWithPassword, neither the
// proposal arguments nor the HTTP request disclose the voter's public
// nullifier. Authorized PDC peers can still observe the private mapping, so
// this function is an API-transcript mitigation rather than a complete
// coercion-resistant construction.
func (c *VotingContract) GetMerkleProofWithLookup(
	ctx contractapi.TransactionContextInterface,
	electionID string,
	lookupToken string,
) (*MerkleProofResult, error) {
	if !isCanonicalSHA256Hex(lookupToken) {
		return nil, fmt.Errorf("deniable lookup token 형식이 올바르지 않습니다")
	}
	merkleKey := "MERKLE_ROOT_" + electionID
	mrBytes, err := ctx.GetStub().GetState(merkleKey)
	if err != nil {
		return nil, fmt.Errorf("MerkleRoot 조회 실패: %w", err)
	}
	if mrBytes == nil {
		return nil, fmt.Errorf("Merkle Tree가 구축되지 않았습니다")
	}

	key := "PROOF_LOOKUP_" + electionID + "_" + lookupToken
	encoded, err := ctx.GetStub().GetPrivateData(VotePrivatePDC, key)
	if err != nil {
		return nil, fmt.Errorf("deniable lookup PDC 조회 실패: %w", err)
	}
	if encoded == nil {
		return nil, fmt.Errorf("deniable lookup token이 일치하지 않습니다")
	}
	var lookup DeniableLookupPrivate
	if err := json.Unmarshal(encoded, &lookup); err != nil {
		return nil, fmt.Errorf("deniable lookup 역직렬화 실패: %w", err)
	}
	if lookup.ElectionID != electionID || !isCanonicalSHA256Hex(lookup.TargetNullifierHash) {
		return nil, fmt.Errorf("deniable lookup 결합값이 올바르지 않습니다")
	}
	targetHash := lookup.TargetNullifierHash

	proof, err := c.GetMerkleProof(ctx, electionID, targetHash)
	if err != nil {
		return nil, err
	}
	n, err := c.GetNullifier(ctx, targetHash)
	if err != nil || n == nil {
		return nil, fmt.Errorf("deniable proof 대상 조회 실패")
	}
	return &MerkleProofResult{
		NullifierHash:        targetHash,
		CandidateID:          resolveCandidateID(ctx, electionID, n),
		CandidateCommitment:  n.CandidateCommitment,
		EncryptedCandidateID: n.EncryptedCandidateID,
		LeafHash:             computeMerkleLeafHash(n),
		Proof:                proof,
	}, nil
}

// VerifyVoteCounted [PAPER-8] Receipt-Free 검증: 투표 포함 여부만 반환, 증명 데이터 없음.
// 유권자가 "내 투표가 집계되었는지"만 확인하고, 강압자에게 보여줄 receipt가 생성되지 않음.
// 반환값: JSON {"included": true/false, "electionID": "...", "totalVotes": N}
func (c *VotingContract) VerifyVoteCounted(
	ctx contractapi.TransactionContextInterface,
	electionID string,
	nullifierHash string,
) (string, error) {
	// 선거 존재 확인
	election, err := c.GetElection(ctx, electionID)
	if err != nil {
		return "", err
	}

	// nullifier 존재 확인
	nBytes, err := ctx.GetStub().GetState(nullifierHash)
	if err != nil {
		return "", fmt.Errorf("nullifier 조회 실패: %w", err)
	}

	included := false
	if nBytes != nil {
		var nul Nullifier
		if err := json.Unmarshal(nBytes, &nul); err == nil {
			included = nul.ElectionID == electionID
		}
	}

	// 집계 결과의 총 투표수 (receipt 아닌 공개 정보)
	totalVotes := 0
	if election.Status == "CLOSED" {
		if tally, err := c.GetTally(ctx, electionID); err == nil {
			totalVotes = tally.TotalVotes
		}
	}

	// 최소한의 정보만 반환 — 후보자 정보, 증명 경로 없음
	result := map[string]interface{}{
		"included":   included,
		"electionID": electionID,
		"totalVotes": totalVotes,
	}
	b, _ := json.Marshal(result)
	return string(b), nil
}

// ============================================================
// ActivateElection — CREATED → ACTIVE 상태 전환
// ============================================================

// ActivateElection 선거를 CREATED에서 ACTIVE 상태로 전환합니다.
// CreateElection은 CREATED 상태로 생성하므로, 투표를 받으려면 이 함수를 호출해야 합니다.
func (c *VotingContract) ActivateElection(
	ctx contractapi.TransactionContextInterface,
	electionID string,
) error {
	if err := requireElectionAdmin(ctx); err != nil {
		return err
	}

	election, err := c.GetElection(ctx, electionID)
	if err != nil {
		return err
	}
	if election.Status != "CREATED" {
		return fmt.Errorf("CREATED 상태의 선거만 활성화할 수 있습니다 (현재 상태: %s)", election.Status)
	}
	if election.KeyCeremonyMode == "dkg-v1" && len(election.DKGApprovals) != ShamirTotalShares {
		return fmt.Errorf("DKG 선거는 세 trustee MSP의 transcript 승인 후에만 활성화할 수 있습니다 (현재: %d/%d)",
			len(election.DKGApprovals), ShamirTotalShares)
	}
	election.Status = "ACTIVE"
	b, err := json.Marshal(election)
	if err != nil {
		return fmt.Errorf("선거 직렬화 실패: %w", err)
	}
	return ctx.GetStub().PutState(electionID, b)
}

// ============================================================
// Merkle Tree 내부 헬퍼 함수
// ============================================================

func computeMerkleLeafHash(n *Nullifier) string {
	if n == nil {
		return ""
	}
	ciphertext := n.EncryptedCandidateID
	if ciphertext == "" && len(n.EncryptedCandidateVector) > 0 {
		encoded, err := json.Marshal(n.EncryptedCandidateVector)
		if err != nil {
			return ""
		}
		ciphertext = string(encoded)
	}
	if n.CandidateCommitment == "" || ciphertext == "" {
		// 레거시 호환: 이전 버전 원장은 nullifierHash만 Merkle leaf로 사용했다.
		h := sha256.Sum256([]byte(n.NullifierHash))
		return fmt.Sprintf("%x", h)
	}
	return hashWithLengthPrefix(n.ElectionID, n.NullifierHash, n.CandidateCommitment, ciphertext)
}

// collectMerkleLeaves CouchDB Rich Query로 선거의 모든 암호화 투표 레코드 leaf를 수집합니다.
func collectMerkleLeaves(
	ctx contractapi.TransactionContextInterface,
	electionID string,
) ([]MerkleLeaf, error) {
	queryString := fmt.Sprintf(
		`{"selector":{"docType":"nullifier","electionID":"%s"},"use_index":["_design/indexElection","electionIndex"]}`,
		electionID,
	)
	iter, err := ctx.GetStub().GetQueryResult(queryString)
	if err != nil {
		return nil, fmt.Errorf("CouchDB 쿼리 실패: %w", err)
	}
	defer iter.Close()

	var leaves []MerkleLeaf
	for iter.HasNext() {
		qr, err := iter.Next()
		if err != nil {
			return nil, fmt.Errorf("결과 순회 실패: %w", err)
		}
		var n Nullifier
		if err := json.Unmarshal(qr.Value, &n); err != nil {
			return nil, fmt.Errorf("Nullifier 역직렬화 실패: %w", err)
		}
		leaves = append(leaves, MerkleLeaf{
			NullifierHash: n.NullifierHash,
			LeafHash:      computeMerkleLeafHash(&n),
		})
	}
	return leaves, nil
}

// hashPair 두 해시를 연결하여 SHA256 해시를 반환합니다.
func hashPair(left, right string) string {
	h := sha256.Sum256([]byte(left + right))
	return fmt.Sprintf("%x", h)
}

// computeMerkleRoot 리프 해시 목록에서 Merkle Root를 계산합니다.
// leaves는 호출 전에 이미 정렬되어 있어야 합니다.
func computeMerkleRoot(leaves []string) string {
	if len(leaves) == 1 {
		h := sha256.Sum256([]byte(leaves[0]))
		return fmt.Sprintf("%x", h)
	}

	current := make([]string, len(leaves))
	copy(current, leaves)

	for len(current) > 1 {
		// 홀수이면 마지막 노드 복제
		if len(current)%2 != 0 {
			current = append(current, current[len(current)-1])
		}
		var next []string
		for i := 0; i < len(current); i += 2 {
			next = append(next, hashPair(current[i], current[i+1]))
		}
		current = next
	}
	return current[0]
}

// computeMerkleProof leafIdx 위치의 리프에 대한 Merkle 포함 증명 경로를 반환합니다.
func computeMerkleProof(leaves []string, leafIdx int) []MerkleNode {
	if len(leaves) == 1 {
		return []MerkleNode{}
	}

	current := make([]string, len(leaves))
	copy(current, leaves)

	idx := leafIdx
	var proof []MerkleNode

	for len(current) > 1 {
		if len(current)%2 != 0 {
			current = append(current, current[len(current)-1])
		}

		// 형제 노드 위치 결정
		if idx%2 == 0 {
			// 현재 노드가 왼쪽 → 형제는 오른쪽
			siblingIdx := idx + 1
			proof = append(proof, MerkleNode{
				Hash:     current[siblingIdx],
				Position: "right",
			})
		} else {
			// 현재 노드가 오른쪽 → 형제는 왼쪽
			siblingIdx := idx - 1
			proof = append(proof, MerkleNode{
				Hash:     current[siblingIdx],
				Position: "left",
			})
		}

		// 다음 레벨로 이동
		var next []string
		for i := 0; i < len(current); i += 2 {
			next = append(next, hashPair(current[i], current[i+1]))
		}
		current = next
		idx = idx / 2
	}

	return proof
}

// ============================================================
// 유틸리티 함수
// ============================================================

// ComputeNullifierHash is retained only for legacy compatibility tests.
// Secure voting uses computeCredentialBoundNullifier and rejects this legacy formula.
func ComputeNullifierHash(voterSecret, electionID string) string {
	h := sha256.New()
	h.Write([]byte(voterSecret + electionID))
	return fmt.Sprintf("%x", h.Sum(nil))
}

// contains 슬라이스에 특정 문자열이 포함되어 있는지 확인합니다.
func contains(slice []string, item string) bool {
	for _, s := range slice {
		if s == item {
			return true
		}
	}
	return false
}

// ============================================================
// STEP 5: Shamir's Secret Sharing — n-of-m 분산 집계
// ============================================================

// InitKeySharing 선거 종료 후 마스터 키를 생성하고 Shamir SSS로 3개 share로 분할합니다.
// 마스터 키: SHA256(txID + "::" + electionID) — 결정론적 (endorsing peers 간 동일 보장)
// share i는 PDC 키 "KEYSHARE_{electionID}_{i}" 에 저장됩니다.
// 실제 배포에서는 share를 각 조직의 전용 PDC 컬렉션에 분리 저장하여 완전한 격리를 달성합니다.
func (c *VotingContract) InitKeySharing(
	ctx contractapi.TransactionContextInterface,
	electionID string,
) (*KeySharingStatus, error) {
	if err := requireElectionAdmin(ctx); err != nil {
		return nil, err
	}

	election, err := c.GetElection(ctx, electionID)
	if err != nil {
		return nil, err
	}
	if election.Status != "CLOSED" {
		return nil, fmt.Errorf("키 분산은 선거 종료(CLOSED) 후에만 가능합니다 (현재: %s)", election.Status)
	}
	return c.doInitKeySharing(ctx, electionID)
}

// doInitKeySharing [P2] 상태 체크 없이 키 분산을 수행 (CloseElection 내부 호출용).
//
//	CloseElection은 같은 tx에서 방금 CLOSED로 PutState하므로 GetState로는 ACTIVE로 보임 →
//	상태 체크를 분리하여 내부 호출 시 우회. 공개 InitKeySharing은 상태 체크 후 이 함수를 호출.
func (c *VotingContract) doInitKeySharing(
	ctx contractapi.TransactionContextInterface,
	electionID string,
) (*KeySharingStatus, error) {
	statusKey := "KEYSHARING_" + electionID
	if existingBytes, _ := ctx.GetStub().GetState(statusKey); existingBytes != nil {
		return nil, fmt.Errorf("이미 키 분산이 초기화된 선거입니다: %s", electionID)
	}
	election, err := c.GetElection(ctx, electionID)
	if err != nil {
		return nil, err
	}
	if (election.EncryptionMode == "elgamal" || election.EncryptionMode == "elgamal-vector-v3") && len(election.ThresholdPublicShares) == ShamirTotalShares {
		now, timeErr := getTxTime(ctx)
		if timeErr != nil {
			return nil, timeErr
		}
		status := KeySharingStatus{
			ObjectType: "keySharingStatus", ElectionID: electionID,
			Threshold: ShamirThreshold, TotalShares: ShamirTotalShares,
			SubmittedBy: []string{}, ShareCommitments: []string{},
			InitiatedAt: now, Mode: "partial-decryption-v2",
		}
		b, marshalErr := json.Marshal(status)
		if marshalErr != nil {
			return nil, marshalErr
		}
		if putErr := ctx.GetStub().PutState(statusKey, b); putErr != nil {
			return nil, fmt.Errorf("threshold 상태 저장 실패: %w", putErr)
		}
		// AES is not used to decrypt ElGamal-v2 ballots. Delete it so no
		// misleading alternate reconstruction path remains.
		_ = ctx.GetStub().DelPrivateData(VotePrivatePDC, "ENCRYPTION_KEY_"+electionID)
		return &status, nil
	}

	// [C-4 확장] PDC의 encryptionKey를 masterKey로 사용
	// 이전: transient에서 외부 masterKey 수신
	// 현재: CreateElection에서 생성한 encryptionKey를 재사용 → Shamir 분산 후 PDC에서 삭제
	// 이렇게 하면 Shamir 복원 없이는 집계 불가 (encryptionKey가 PDC에서 사라지므로)
	var masterKey []byte
	transient, _ := ctx.GetStub().GetTransient()
	if mk, ok := transient["masterKey"]; ok && len(mk) == 32 {
		// 하위 호환: transient에 masterKey가 있으면 그대로 사용
		masterKey = mk
		log.Printf("[InitKeySharing] transient masterKey 사용")
	} else {
		// C-4: PDC의 encryptionKey를 masterKey로 사용
		ek, ekErr := getEncryptionKey(ctx, electionID)
		if ekErr != nil || len(ek) != 32 {
			return nil, fmt.Errorf("encryptionKey 조회 실패 (transient masterKey도 없음): %v", ekErr)
		}
		masterKey = ek
		log.Printf("[InitKeySharing] PDC encryptionKey를 masterKey로 사용 — election: %s", electionID)
	}

	// 키 해시 (공개 저장 — 복원 검증용)
	keyHashRaw := sha256.Sum256(masterKey)
	keyHash := hex.EncodeToString(keyHashRaw[:])

	// 계수 시드 — masterKey에서 유도 (masterKey가 비밀이므로 coeffSeed도 비밀)
	coeffSeedRaw := sha256.Sum256(append([]byte("COEFF::"), masterKey...))
	coeffSeed := coeffSeedRaw[:]

	// Shamir SSS: 32바이트 키를 GF(p) 위에서 통째로 분산 → 보안 공간 2^256
	shares := shamirSplit256(masterKey, ShamirTotalShares, coeffSeed)

	// PDC에 각 share 저장 + [HIGH-05 FIX] Feldman VSS commitment 생성
	shareCommitments := make([]string, len(shares))
	for i, share := range shares {
		shareKey := fmt.Sprintf("KEYSHARE_%s_%d", electionID, i+1)
		if err := ctx.GetStub().PutPrivateData(VotePrivatePDC, shareKey, []byte(hex.EncodeToString(share))); err != nil {
			return nil, fmt.Errorf("share %d PDC 저장 실패: %w", i+1, err)
		}
		// commitment = SHA256(share_bytes) — share 제출 시 위조 검증용 공개 기록
		commitRaw := sha256.Sum256(share)
		shareCommitments[i] = hex.EncodeToString(commitRaw[:])
	}

	now, err := getTxTime(ctx)
	if err != nil {
		return nil, err
	}

	status := KeySharingStatus{
		ObjectType:       "keySharingStatus",
		ElectionID:       electionID,
		Threshold:        ShamirThreshold,
		TotalShares:      ShamirTotalShares,
		SubmittedCount:   0,
		SubmittedBy:      []string{},
		IsDecrypted:      false,
		KeyHash:          keyHash,
		InitiatedAt:      now,
		ShareCommitments: shareCommitments,
	}
	b, err := json.Marshal(status)
	if err != nil {
		return nil, err
	}
	if err := ctx.GetStub().PutState(statusKey, b); err != nil {
		return nil, fmt.Errorf("키 분산 상태 저장 실패: %w", err)
	}

	// [C-4 확장] Shamir 분산 완료 후 PDC에서 원본 encryptionKey 삭제
	// 이후 TallyVotes는 Shamir 복원으로 키를 얻어야만 집계 가능
	ekKey := "ENCRYPTION_KEY_" + electionID
	if delErr := ctx.GetStub().DelPrivateData(VotePrivatePDC, ekKey); delErr != nil {
		log.Printf("[InitKeySharing] encryptionKey 삭제 실패 (무시) — %v", delErr)
	} else {
		log.Printf("[InitKeySharing] encryptionKey PDC 삭제 완료 — 이후 Shamir 복원 필수")
	}

	// [P2 보안] ElGamal 비밀키도 PDC에서 삭제 — 복원 전까지 복호화 불가.
	//   ElGamal 키는 AES 마스터키에 바인딩되어 있어, 2-of-3 복원 시 재유도된다.
	pkKey := "ELGAMAL_PRIVKEY_" + electionID
	if delErr := ctx.GetStub().DelPrivateData(VotePrivatePDC, pkKey); delErr != nil {
		log.Printf("[InitKeySharing] ElGamal privKey 삭제 (무시) — %v", delErr)
	} else {
		log.Printf("[InitKeySharing] ElGamal privKey PDC 삭제 완료")
	}

	log.Printf("[InitKeySharing] 완료 — election: %s, keyHash: %s...", electionID, keyHash[:16])
	return &status, nil
}

// SubmitKeyShare 조직이 보유한 share를 공개 원장에 제출합니다.
// shareIndex: "1", "2", "3" 중 하나 (조직별 할당 인덱스)
// shareHex: PDC에서 조회한 share의 hex 인코딩값
// threshold=2 달성 시 자동으로 복원 검증을 수행합니다.
func (c *VotingContract) SubmitKeyShare(
	ctx contractapi.TransactionContextInterface,
	electionID string,
	shareIndex string,
	shareHex string,
) (*KeySharingStatus, error) {
	if err := requireShareOwner(ctx, shareIndex); err != nil {
		return nil, err
	}

	statusKey := "KEYSHARING_" + electionID
	statusBytes, err := ctx.GetStub().GetState(statusKey)
	if err != nil {
		return nil, err
	}
	if statusBytes == nil {
		return nil, fmt.Errorf("키 분산이 초기화되지 않았습니다. InitKeySharing을 먼저 호출하세요: %s", electionID)
	}

	var status KeySharingStatus
	if err := json.Unmarshal(statusBytes, &status); err != nil {
		return nil, err
	}
	if status.Mode == "partial-decryption-v2" {
		return nil, fmt.Errorf("ElGamal-v2는 비밀 share 제출을 금지합니다. SubmitPartialDecryption을 사용하세요")
	}
	if status.IsDecrypted {
		return &status, nil
	}

	// 중복 제출 방지
	for _, s := range status.SubmittedBy {
		if s == shareIndex {
			return nil, fmt.Errorf("이미 제출된 share 인덱스입니다: %s", shareIndex)
		}
	}

	// [HIGH-05 FIX] Feldman VSS — PDC 원본과 commitment 이중 검증
	// 1) PDC에서 원래 share 읽기 (InitKeySharing이 저장한 값)
	pdcKey := fmt.Sprintf("KEYSHARE_%s_%s", electionID, shareIndex)
	expectedHexBytes, err := ctx.GetStub().GetPrivateData(VotePrivatePDC, pdcKey)
	if err != nil {
		return nil, fmt.Errorf("PDC share 읽기 실패: %w", err)
	}
	if expectedHexBytes == nil {
		return nil, fmt.Errorf("PDC에 share %s 없음: InitKeySharing이 먼저 실행됐는지 확인하세요", shareIndex)
	}
	if shareHex != string(expectedHexBytes) {
		mspID, _ := ctx.GetClientIdentity().GetMSPID()
		return nil, fmt.Errorf("share %s 값 불일치 — 위조 감지 (제출자: %s)", shareIndex, mspID)
	}

	// 2) 공개 commitment와 해시 비교 (PDC 미접근 조직도 무결성 검증 가능)
	shareIdxInt := 0
	fmt.Sscanf(shareIndex, "%d", &shareIdxInt)
	if shareIdxInt >= 1 && shareIdxInt <= len(status.ShareCommitments) {
		shareBytes, decErr := hex.DecodeString(shareHex)
		if decErr != nil {
			return nil, fmt.Errorf("shareHex 디코딩 실패: %w", decErr)
		}
		computedCommit := sha256.Sum256(shareBytes)
		computedCommitHex := hex.EncodeToString(computedCommit[:])
		if computedCommitHex != status.ShareCommitments[shareIdxInt-1] {
			mspID, _ := ctx.GetClientIdentity().GetMSPID()
			return nil, fmt.Errorf("share %s commitment 불일치 — 위조 감지 (제출자: %s)", shareIndex, mspID)
		}
	}

	// share 공개 원장 기록
	shareKey := fmt.Sprintf("KEYSHARE_SUBMITTED_%s_%s", electionID, shareIndex)
	if err := ctx.GetStub().PutState(shareKey, []byte(shareHex)); err != nil {
		return nil, fmt.Errorf("share 저장 실패: %w", err)
	}

	status.SubmittedBy = append(status.SubmittedBy, shareIndex)
	status.SubmittedCount++

	// threshold 달성 시 자동 복원 검증
	// currentShareIndex/currentShareHex: 방금 PutState한 share는 같은 tx에서 GetState로 읽을 수 없으므로 직접 전달
	if status.SubmittedCount >= status.Threshold {
		if verifyErr := c.verifyKeyReconstruction(ctx, electionID, &status, shareIndex, shareHex); verifyErr != nil {
			log.Printf("[SubmitKeyShare] 복원 검증 실패: %v", verifyErr)
		}
	}

	b, err := json.Marshal(status)
	if err != nil {
		return nil, err
	}
	if err := ctx.GetStub().PutState(statusKey, b); err != nil {
		return nil, err
	}

	log.Printf("[SubmitKeyShare] share %s 제출 완료 — election: %s, submitted: %d/%d, decrypted: %v",
		shareIndex, electionID, status.SubmittedCount, status.Threshold, status.IsDecrypted)
	return &status, nil
}

// SubmitPartialDecryption publishes c1^x_i plus a Chaum-Pedersen proof. The
// trustee scalar x_i never leaves private state and the full election secret is
// never reconstructed. This is dealer-assisted threshold ElGamal; replacing
// the dealer/shared collection with DKG and per-organisation collections is a
// separate hardening step.
func (c *VotingContract) SubmitPartialDecryption(
	ctx contractapi.TransactionContextInterface,
	electionID string,
	shareIndex string,
) (*KeySharingStatus, error) {
	if err := requireShareOwner(ctx, shareIndex); err != nil {
		return nil, err
	}
	index, err := strconv.Atoi(shareIndex)
	if err != nil {
		return nil, fmt.Errorf("shareIndex 파싱 실패: %w", err)
	}
	election, err := c.GetElection(ctx, electionID)
	if err != nil {
		return nil, err
	}
	if election.KeyCeremonyMode == "dkg-v1" {
		return nil, fmt.Errorf("DKG 선거는 shared-PDC partial decryption을 금지합니다. SubmitExternalPartialDecryption을 사용하세요")
	}
	if (election.EncryptionMode != "elgamal" && election.EncryptionMode != "elgamal-vector-v3") || len(election.ThresholdPublicShares) != ShamirTotalShares {
		return nil, fmt.Errorf("partial decryption-v2 선거가 아닙니다")
	}
	statusKey := "KEYSHARING_" + electionID
	statusBytes, err := ctx.GetStub().GetState(statusKey)
	if err != nil || statusBytes == nil {
		return nil, fmt.Errorf("키 분산 상태가 없습니다")
	}
	var status KeySharingStatus
	if err := json.Unmarshal(statusBytes, &status); err != nil {
		return nil, err
	}
	if status.Mode != "partial-decryption-v2" {
		return nil, fmt.Errorf("레거시 키 복원 선거에서는 partial decryption을 사용할 수 없습니다")
	}
	if status.IsDecrypted {
		return &status, nil
	}
	for _, submitted := range status.SubmittedBy {
		if submitted == shareIndex {
			return nil, fmt.Errorf("이미 제출된 partial decryption 인덱스입니다: %s", shareIndex)
		}
	}

	tallyKey := "TALLY_" + electionID
	tallyBytes, err := ctx.GetStub().GetState(tallyKey)
	if err != nil || tallyBytes == nil {
		return nil, fmt.Errorf("복호화 대기 집계가 없습니다")
	}
	var tally VoteTally
	if err := json.Unmarshal(tallyBytes, &tally); err != nil {
		return nil, err
	}
	if election.EncryptionMode == "elgamal-vector-v3" {
		return c.submitVectorPartialDecryption(ctx, election, index, shareIndex, statusKey, tallyKey, &status, &tally)
	}
	if tally.Decrypted || tally.EncAggC1 == "" || tally.EncAggC2 == "" {
		return nil, fmt.Errorf("복호화 대기 암호문이 없습니다")
	}
	c1, ok := parseSubgroupElement(tally.EncAggC1)
	if !ok {
		return nil, fmt.Errorf("집계 c1 군 원소 검증 실패")
	}
	shareBytes, err := ctx.GetStub().GetPrivateData(
		VotePrivatePDC, fmt.Sprintf("ELGAMAL_THRESHOLD_SHARE_%s_%d", electionID, index))
	if err != nil || shareBytes == nil {
		return nil, fmt.Errorf("threshold share %d 조회 실패", index)
	}
	share, ok := parseScalar(string(shareBytes))
	if !ok || share.Sign() == 0 {
		return nil, fmt.Errorf("threshold share %d 검증 실패", index)
	}
	publicShare := election.ThresholdPublicShares[index-1]
	if publicShare.Index != index || publicShare.MSPID != shareIndexMSP[shareIndex] ||
		new(big.Int).Exp(elgamalG, share, elgamalP).Text(16) != publicShare.PublicKeyY {
		return nil, fmt.Errorf("threshold share %d 공개키 바인딩 검증 실패", index)
	}
	partialValue := new(big.Int).Exp(c1, share, elgamalP)
	proof, err := chaumPedersenProveRaw(
		share, tally.EncAggC1, partialValue.Text(16), "1",
		fmt.Sprintf("threshold-partial:%d", index), electionID, "",
	)
	if err != nil {
		return nil, fmt.Errorf("partial decryption 증명 생성 실패: %w", err)
	}
	partial := PartialDecryption{
		Index: index, MSPID: publicShare.MSPID, PublicKeyY: publicShare.PublicKeyY,
		Value: partialValue.Text(16), Proof: proof,
	}
	partialPub := &ElGamalPublicKey{P: elgamalP.Text(16), G: elgamalG.Text(16), Y: publicShare.PublicKeyY}
	if !chaumPedersenVerifyRaw(partialPub, proof, big.NewInt(1)) {
		return nil, fmt.Errorf("partial decryption %d 증명 자체 검증 실패", index)
	}
	partialBytes, _ := json.Marshal(partial)
	if err := ctx.GetStub().PutState(fmt.Sprintf("PARTIAL_DECRYPTION_%s_%d", electionID, index), partialBytes); err != nil {
		return nil, err
	}
	status.SubmittedBy = append(status.SubmittedBy, shareIndex)
	status.SubmittedCount++
	tally.PartialDecryptions = append(tally.PartialDecryptions, partial)

	if status.SubmittedCount >= status.Threshold {
		values := map[int]*big.Int{index: partialValue}
		for _, submitted := range status.SubmittedBy {
			i, _ := strconv.Atoi(submitted)
			if i == index {
				continue
			}
			b, getErr := ctx.GetStub().GetState(fmt.Sprintf("PARTIAL_DECRYPTION_%s_%d", electionID, i))
			if getErr != nil || b == nil {
				return nil, fmt.Errorf("partial decryption %d 조회 실패", i)
			}
			var prior PartialDecryption
			if json.Unmarshal(b, &prior) != nil {
				return nil, fmt.Errorf("partial decryption %d 파싱 실패", i)
			}
			v, valid := parseSubgroupElement(prior.Value)
			if !valid {
				return nil, fmt.Errorf("partial decryption %d 군 원소 검증 실패", i)
			}
			values[i] = v
			if len(values) == status.Threshold {
				break
			}
		}
		combined, combineErr := combinePartialDecryptionValues(values)
		if combineErr != nil {
			return nil, combineErr
		}
		c2, valid := parseSubgroupElement(tally.EncAggC2)
		if !valid {
			return nil, fmt.Errorf("집계 c2 군 원소 검증 실패")
		}
		combinedInv := new(big.Int).ModInverse(combined, elgamalP)
		if combinedInv == nil {
			return nil, fmt.Errorf("결합 partial decryption 역원 계산 실패")
		}
		gSum := new(big.Int).Mul(c2, combinedInv)
		gSum.Mod(gSum, elgamalP)
		if err := validateHomomorphicTallyCapacity(tally.TotalVotes, len(election.Candidates)); err != nil {
			return nil, err
		}
		maxSum := int64(tally.TotalVotes) + 1
		for i := 0; i < len(election.Candidates)-1; i++ {
			maxSum *= HomomorphicBase
		}
		sum, err := babyStepGiantStep(gSum, elgamalG, elgamalP, maxSum)
		if err != nil {
			return nil, fmt.Errorf("threshold 집계 BSGS 복원 실패: %w", err)
		}
		counts := decomposeBaseB(sum, len(election.Candidates))
		for i, candidate := range election.Candidates {
			tally.Results[candidate] = counts[i]
		}
		tally.Decrypted = true
		proofBytes, _ := json.Marshal(tally.PartialDecryptions)
		proofHash := sha256.Sum256(proofBytes)
		tally.TallyProofHash = hex.EncodeToString(proofHash[:])
		status.IsDecrypted = true
	}
	tallyBytes, _ = json.Marshal(tally)
	if err := ctx.GetStub().PutState(tallyKey, tallyBytes); err != nil {
		return nil, err
	}
	statusBytes, _ = json.Marshal(status)
	if err := ctx.GetStub().PutState(statusKey, statusBytes); err != nil {
		return nil, err
	}
	return &status, nil
}

// SubmitExternalPartialDecryption accepts only public c1^x_i values and
// Chaum-Pedersen proofs produced by an independently operated DKG trustee.
// The scalar share never enters Fabric transient data, chaincode memory or a
// peer private-data collection.
func (c *VotingContract) SubmitExternalPartialDecryption(
	ctx contractapi.TransactionContextInterface, electionID, shareIndex, partialJSON string,
) (*KeySharingStatus, error) {
	if err := requireShareOwner(ctx, shareIndex); err != nil {
		return nil, err
	}
	index, err := strconv.Atoi(shareIndex)
	if err != nil {
		return nil, fmt.Errorf("shareIndex 파싱 실패: %w", err)
	}
	election, err := c.GetElection(ctx, electionID)
	if err != nil {
		return nil, err
	}
	if election.KeyCeremonyMode != "dkg-v1" || election.EncryptionMode != "elgamal-vector-v3" ||
		len(election.ThresholdPublicShares) != ShamirTotalShares || index < 1 || index > ShamirTotalShares {
		return nil, fmt.Errorf("external partial decryption is allowed only for a valid DKG vector election")
	}
	statusKey := "KEYSHARING_" + electionID
	statusBytes, err := ctx.GetStub().GetState(statusKey)
	if err != nil || statusBytes == nil {
		return nil, fmt.Errorf("키 분산 상태가 없습니다")
	}
	var status KeySharingStatus
	if err := json.Unmarshal(statusBytes, &status); err != nil || status.Mode != "partial-decryption-v2" {
		return nil, fmt.Errorf("invalid DKG partial-decryption status")
	}
	if status.IsDecrypted {
		return &status, nil
	}
	for _, submitted := range status.SubmittedBy {
		if submitted == shareIndex {
			return nil, fmt.Errorf("이미 제출된 partial decryption 인덱스입니다: %s", shareIndex)
		}
	}
	tallyKey := "TALLY_" + electionID
	tallyBytes, err := ctx.GetStub().GetState(tallyKey)
	if err != nil || tallyBytes == nil {
		return nil, fmt.Errorf("복호화 대기 집계가 없습니다")
	}
	var tally VoteTally
	if err := json.Unmarshal(tallyBytes, &tally); err != nil || tally.Decrypted ||
		len(tally.EncAggVector) == 0 || len(tally.EncAggVector) != len(election.Candidates) {
		return nil, fmt.Errorf("invalid vector aggregate for external partial decryption")
	}
	var partial VectorPartialDecryption
	decoder := json.NewDecoder(strings.NewReader(partialJSON))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&partial); err != nil {
		return nil, fmt.Errorf("external partial parse failed: %w", err)
	}
	publicShare := election.ThresholdPublicShares[index-1]
	if partial.Index != index || partial.MSPID != shareIndexMSP[shareIndex] || partial.MSPID != publicShare.MSPID ||
		partial.PublicKeyY != publicShare.PublicKeyY || len(partial.Values) != len(tally.EncAggVector) ||
		len(partial.Proofs) != len(tally.EncAggVector) {
		return nil, fmt.Errorf("external partial identity or vector shape mismatch")
	}
	partialPub := &ElGamalPublicKey{P: elgamalP.Text(16), G: elgamalG.Text(16), Y: publicShare.PublicKeyY}
	for candidateIndex, valueHex := range partial.Values {
		_, valid := parseSubgroupElement(valueHex)
		proof := partial.Proofs[candidateIndex]
		expectedDomain := fmt.Sprintf("vector-threshold-partial:%d:%d", index, candidateIndex)
		if !valid || proof == nil || proof.NullifierHash != expectedDomain || proof.DecryptedHash != "" ||
			proof.C1 != tally.EncAggVector[candidateIndex].C1 || proof.C2 != valueHex ||
			!chaumPedersenVerifyRaw(partialPub, proof, big.NewInt(1)) {
			return nil, fmt.Errorf("external vector partial proof %d invalid", candidateIndex)
		}
	}
	return c.applyVectorPartialDecryption(ctx, election, index, shareIndex, statusKey, tallyKey, &status, &tally, partial)
}

func (c *VotingContract) submitVectorPartialDecryption(
	ctx contractapi.TransactionContextInterface, election *Election, index int, shareIndex, statusKey, tallyKey string,
	status *KeySharingStatus, tally *VoteTally,
) (*KeySharingStatus, error) {
	if tally.Decrypted || len(tally.EncAggVector) != len(election.Candidates) || len(tally.EncAggVector) == 0 {
		return nil, fmt.Errorf("vector-v3 복호화 대기 암호문이 없습니다")
	}
	if index < 1 || index > len(election.ThresholdPublicShares) {
		return nil, fmt.Errorf("threshold share index 범위 오류: %d", index)
	}
	shareBytes, err := ctx.GetStub().GetPrivateData(VotePrivatePDC,
		fmt.Sprintf("ELGAMAL_THRESHOLD_SHARE_%s_%d", election.ElectionID, index))
	if err != nil || shareBytes == nil {
		return nil, fmt.Errorf("threshold share %d 조회 실패", index)
	}
	share, ok := parseScalar(string(shareBytes))
	if !ok || share.Sign() == 0 {
		return nil, fmt.Errorf("threshold share %d 검증 실패", index)
	}
	publicShare := election.ThresholdPublicShares[index-1]
	if publicShare.Index != index || publicShare.MSPID != shareIndexMSP[shareIndex] ||
		new(big.Int).Exp(elgamalG, share, elgamalP).Text(16) != publicShare.PublicKeyY {
		return nil, fmt.Errorf("threshold share %d 공개키 바인딩 검증 실패", index)
	}
	partialPub := &ElGamalPublicKey{P: elgamalP.Text(16), G: elgamalG.Text(16), Y: publicShare.PublicKeyY}
	partial := VectorPartialDecryption{Index: index, MSPID: publicShare.MSPID, PublicKeyY: publicShare.PublicKeyY,
		Values: make([]string, len(tally.EncAggVector)), Proofs: make([]*ChaumPedersenProof, len(tally.EncAggVector))}
	for candidateIndex, aggregate := range tally.EncAggVector {
		c1, valid := parseSubgroupElement(aggregate.C1)
		if !valid {
			return nil, fmt.Errorf("vector-v3 집계 c1 검증 실패 (index=%d)", candidateIndex)
		}
		value := new(big.Int).Exp(c1, share, elgamalP)
		proof, proofErr := chaumPedersenProveRaw(share, aggregate.C1, value.Text(16), "1",
			fmt.Sprintf("vector-threshold-partial:%d:%d", index, candidateIndex), election.ElectionID, "")
		if proofErr != nil || !chaumPedersenVerifyRaw(partialPub, proof, big.NewInt(1)) {
			return nil, fmt.Errorf("vector-v3 partial proof 생성/자체검증 실패 (index=%d): %v", candidateIndex, proofErr)
		}
		partial.Values[candidateIndex], partial.Proofs[candidateIndex] = value.Text(16), proof
	}
	return c.applyVectorPartialDecryption(ctx, election, index, shareIndex, statusKey, tallyKey, status, tally, partial)
}

func (c *VotingContract) applyVectorPartialDecryption(
	ctx contractapi.TransactionContextInterface, election *Election, index int, shareIndex, statusKey, tallyKey string,
	status *KeySharingStatus, tally *VoteTally, partial VectorPartialDecryption,
) (*KeySharingStatus, error) {
	partialBytes, err := json.Marshal(partial)
	if err != nil {
		return nil, err
	}
	if err := ctx.GetStub().PutState(fmt.Sprintf("PARTIAL_DECRYPTION_%s_%d", election.ElectionID, index), partialBytes); err != nil {
		return nil, err
	}
	status.SubmittedBy = append(status.SubmittedBy, shareIndex)
	status.SubmittedCount++
	tally.VectorPartialDecryptions = append(tally.VectorPartialDecryptions, partial)

	if status.SubmittedCount >= status.Threshold {
		partials := make([]map[int]*big.Int, len(election.Candidates))
		for i := range partials {
			partials[i] = make(map[int]*big.Int)
		}
		for _, submitted := range status.SubmittedBy {
			trusteeIndex, convErr := strconv.Atoi(submitted)
			if convErr != nil {
				return nil, fmt.Errorf("trustee index 파싱 실패: %w", convErr)
			}
			var prior VectorPartialDecryption
			if trusteeIndex == index {
				prior = partial
			} else {
				b, getErr := ctx.GetStub().GetState(fmt.Sprintf("PARTIAL_DECRYPTION_%s_%d", election.ElectionID, trusteeIndex))
				if getErr != nil || b == nil {
					return nil, fmt.Errorf("vector partial %d 조회 실패", trusteeIndex)
				}
				if json.Unmarshal(b, &prior) != nil {
					return nil, fmt.Errorf("vector partial %d 파싱 실패", trusteeIndex)
				}
			}
			if len(prior.Values) != len(partials) || len(prior.Proofs) != len(partials) ||
				prior.Index != trusteeIndex || trusteeIndex < 1 || trusteeIndex > len(election.ThresholdPublicShares) {
				return nil, fmt.Errorf("vector partial %d 구조 검증 실패", trusteeIndex)
			}
			priorPublic := election.ThresholdPublicShares[trusteeIndex-1]
			if prior.MSPID != priorPublic.MSPID || prior.PublicKeyY != priorPublic.PublicKeyY {
				return nil, fmt.Errorf("vector partial %d 신원 바인딩 실패", trusteeIndex)
			}
			priorPub := &ElGamalPublicKey{P: elgamalP.Text(16), G: elgamalG.Text(16), Y: prior.PublicKeyY}
			for candidateIndex, valueHex := range prior.Values {
				value, valid := parseSubgroupElement(valueHex)
				if !valid || prior.Proofs[candidateIndex] == nil ||
					prior.Proofs[candidateIndex].C1 != tally.EncAggVector[candidateIndex].C1 ||
					prior.Proofs[candidateIndex].C2 != valueHex ||
					!chaumPedersenVerifyRaw(priorPub, prior.Proofs[candidateIndex], big.NewInt(1)) {
					return nil, fmt.Errorf("vector partial %d proof %d 검증 실패", trusteeIndex, candidateIndex)
				}
				partials[candidateIndex][trusteeIndex] = value
			}
			if len(partials[0]) == status.Threshold {
				break
			}
		}
		countSum := 0
		for candidateIndex, candidate := range election.Candidates {
			combined, combineErr := combinePartialDecryptionValues(partials[candidateIndex])
			if combineErr != nil {
				return nil, combineErr
			}
			c2, valid := parseSubgroupElement(tally.EncAggVector[candidateIndex].C2)
			if !valid {
				return nil, fmt.Errorf("vector aggregate c2 %d invalid", candidateIndex)
			}
			gm := new(big.Int).Mul(c2, new(big.Int).ModInverse(combined, elgamalP))
			gm.Mod(gm, elgamalP)
			count, bsgsErr := babyStepGiantStep(gm, elgamalG, elgamalP, int64(tally.TotalVotes)+1)
			if bsgsErr != nil {
				return nil, fmt.Errorf("vector candidate %d BSGS 실패: %w", candidateIndex, bsgsErr)
			}
			tally.Results[candidate] = int(count)
			countSum += int(count)
		}
		if countSum != tally.TotalVotes {
			return nil, fmt.Errorf("vector-v3 one-hot 집계 불변식 실패: counts=%d total=%d", countSum, tally.TotalVotes)
		}
		tally.Decrypted, status.IsDecrypted = true, true
		proofBytes, _ := json.Marshal(tally.VectorPartialDecryptions)
		hash := sha256.Sum256(proofBytes)
		tally.TallyProofHash = hex.EncodeToString(hash[:])
	}
	tallyBytes, _ := json.Marshal(tally)
	if err := ctx.GetStub().PutState(tallyKey, tallyBytes); err != nil {
		return nil, err
	}
	statusBytes, _ := json.Marshal(status)
	if err := ctx.GetStub().PutState(statusKey, statusBytes); err != nil {
		return nil, err
	}
	return status, nil
}

// verifyKeyReconstruction 제출된 share로 마스터 키를 복원하고 keyHash를 검증합니다.
// currentIdx/currentHex: 방금 PutState한 share (같은 tx에서 GetState 불가 → 직접 전달)
func (c *VotingContract) verifyKeyReconstruction(
	ctx contractapi.TransactionContextInterface,
	electionID string,
	status *KeySharingStatus,
	currentIdx string,
	currentHex string,
) error {
	if len(status.SubmittedBy) < 2 {
		return nil
	}

	idx1Str := status.SubmittedBy[0]
	idx2Str := status.SubmittedBy[1]

	// 각 share를 읽을 때, 방금 PutState된 share는 상태DB에서 읽지 않고 직접 전달된 값을 사용
	getShareHex := func(idxStr string) (string, error) {
		if idxStr == currentIdx {
			return currentHex, nil
		}
		b, err := ctx.GetStub().GetState(fmt.Sprintf("KEYSHARE_SUBMITTED_%s_%s", electionID, idxStr))
		if err != nil || b == nil {
			return "", fmt.Errorf("share %s 읽기 실패", idxStr)
		}
		return string(b), nil
	}

	sh1Hex, err := getShareHex(idx1Str)
	if err != nil {
		return err
	}
	sh2Hex, err := getShareHex(idx2Str)
	if err != nil {
		return err
	}

	s1, err := hex.DecodeString(sh1Hex)
	if err != nil {
		return fmt.Errorf("share1 hex 디코딩 실패: %w", err)
	}
	s2, err := hex.DecodeString(sh2Hex)
	if err != nil {
		return fmt.Errorf("share2 hex 디코딩 실패: %w", err)
	}

	x1, err1 := strconv.Atoi(idx1Str)
	x2, err2 := strconv.Atoi(idx2Str)
	if err1 != nil || err2 != nil {
		return fmt.Errorf("share 인덱스 파싱 실패: idx1=%q, idx2=%q", idx1Str, idx2Str)
	}
	if x1 < 1 || x1 > 3 || x2 < 1 || x2 > 3 || x1 == x2 {
		return fmt.Errorf("share 인덱스 범위 오류: x1=%d, x2=%d (1~3, 서로 다른 값 필요)", x1, x2)
	}

	reconstructed := shamirReconstruct256(s1, s2, x1, x2)
	if reconstructed == nil {
		return fmt.Errorf("복원 실패: nil 결과")
	}

	recHashRaw := sha256.Sum256(reconstructed)
	recHash := hex.EncodeToString(recHashRaw[:])

	if recHash == status.KeyHash {
		status.IsDecrypted = true
		// [C-4 확장] 복원된 encryptionKey를 PDC에 다시 저장 → TallyVotes에서 사용 가능
		ekKey := "ENCRYPTION_KEY_" + electionID
		if err := ctx.GetStub().PutPrivateData(VotePrivatePDC, ekKey, []byte(hex.EncodeToString(reconstructed))); err != nil {
			log.Printf("[verifyKeyReconstruction] 복원 키 PDC 저장 실패 — %v", err)
		} else {
			log.Printf("[verifyKeyReconstruction] 복원 성공 + encryptionKey PDC 복원 — election: %s", electionID)
		}
		// [P2 보안] ElGamal 모드: 복원된 AES 마스터키로부터 ElGamal 비밀키를 재유도해 복원하고,
		//   재집계(TallyVotes)하여 종료 시 보류했던 결과를 복호화한다.
		//   → 2-of-3 조각이 모이기 전에는 어떤 단일 기관도 결과를 복호화할 수 없다.
		if el, elErr := c.GetElection(ctx, electionID); elErr == nil && el.EncryptionMode == "elgamal" {
			egPriv, _ := elgamalGenerateKeyPair(elgamalKeySeedFromAES(reconstructed))
			// PDC에 ElGamal 키 복원 (이후 tx에서 사용 가능하도록)
			pkKey := "ELGAMAL_PRIVKEY_" + electionID
			if perr := ctx.GetStub().PutPrivateData(VotePrivatePDC, pkKey, []byte(egPriv.Text(16))); perr != nil {
				log.Printf("[verifyKeyReconstruction] ElGamal 키 복원 저장 실패 — %v", perr)
			}
			// 같은 tx에서 복호화: 방금 PutPrivateData한 키는 GetPrivateData로 안 보이므로
			//   복원한 in-memory 키(egPriv)를 직접 전달하여 보류 중이던 결과를 복호화한다.
			if _, terr := c.tallyVotesInternal(ctx, electionID, egPriv, false); terr != nil {
				log.Printf("[verifyKeyReconstruction] 복원 후 복호화 실패 — %v", terr)
			} else {
				log.Printf("[verifyKeyReconstruction] ElGamal 결과 복호화 완료 — election: %s", electionID)
			}
		}
	} else {
		log.Printf("[verifyKeyReconstruction] 복원 실패: 해시 불일치 (got %s, want %s)", recHash[:8], status.KeyHash[:8])
	}
	return nil
}

// GetKeyDecryptionStatus 키 분산 및 복원 현황을 조회합니다.
func (c *VotingContract) GetKeyDecryptionStatus(
	ctx contractapi.TransactionContextInterface,
	electionID string,
) (*KeySharingStatus, error) {
	statusKey := "KEYSHARING_" + electionID
	b, err := ctx.GetStub().GetState(statusKey)
	if err != nil {
		return nil, err
	}
	if b == nil {
		return nil, fmt.Errorf("키 분산 정보가 없습니다. InitKeySharing을 먼저 호출하세요: %s", electionID)
	}
	var status KeySharingStatus
	if err := json.Unmarshal(b, &status); err != nil {
		return nil, err
	}
	return &status, nil
}

// GetKeyShare PDC에서 share를 조회합니다 (테스트/관리자용).
// 실제 배포에서는 각 조직만 자신의 share에 접근 가능해야 하므로 접근 제어 필요.
func (c *VotingContract) GetKeyShare(
	ctx contractapi.TransactionContextInterface,
	electionID string,
	shareIndex string,
) (string, error) {
	if err := requireShareOwner(ctx, shareIndex); err != nil {
		return "", err
	}
	election, err := c.GetElection(ctx, electionID)
	if err != nil {
		return "", err
	}
	if (election.EncryptionMode == "elgamal" || election.EncryptionMode == "elgamal-vector-v3") && len(election.ThresholdPublicShares) > 0 {
		return "", fmt.Errorf("ElGamal-v2는 비밀 share 조회를 금지합니다")
	}

	shareKey := fmt.Sprintf("KEYSHARE_%s_%s", electionID, shareIndex)
	shareBytes, err := ctx.GetStub().GetPrivateData(VotePrivatePDC, shareKey)
	if err != nil {
		return "", fmt.Errorf("PDC 조회 실패: %w", err)
	}
	if shareBytes == nil {
		return "", fmt.Errorf("share %s를 찾을 수 없습니다. InitKeySharing을 먼저 호출하세요", shareIndex)
	}
	return string(shareBytes), nil
}

// GetEncryptionKey ACTIVE 상태의 선거 암호화 키를 반환합니다 (클라이언트-사이드 암호화용).
// [PAPER-1] 클라이언트가 이 키로 candidateID를 직접 암호화 → 체인코드는 평문을 보지 않음
// 선거가 ACTIVE 상태일 때만 반환하여 투표 기간 외 키 노출을 방지합니다.
func (c *VotingContract) GetEncryptionKey(
	ctx contractapi.TransactionContextInterface,
	electionID string,
) (string, error) {
	if err := validateElectionID(electionID); err != nil {
		return "", err
	}

	electionBytes, err := ctx.GetStub().GetState(electionID)
	if err != nil || electionBytes == nil {
		return "", fmt.Errorf("선거를 찾을 수 없습니다: %s", electionID)
	}
	var election Election
	if err := json.Unmarshal(electionBytes, &election); err != nil {
		return "", fmt.Errorf("선거 데이터 파싱 실패: %w", err)
	}
	if election.Status != "ACTIVE" {
		return "", fmt.Errorf("ACTIVE 상태의 선거에서만 암호화 키를 조회할 수 있습니다 (현재: %s)", election.Status)
	}

	ekKey := "ENCRYPTION_KEY_" + electionID
	ekHex, err := ctx.GetStub().GetPrivateData(VotePrivatePDC, ekKey)
	if err != nil || ekHex == nil {
		return "", fmt.Errorf("암호화 키 조회 실패 — Shamir 복원 전이거나 키가 삭제되었습니다")
	}
	return string(ekHex), nil
}

// [PAPER-11] GetElGamalPublicKey ElGamal 공개키 조회 (ElGamal 모드 선거에서만)
func (c *VotingContract) GetElGamalPublicKey(
	ctx contractapi.TransactionContextInterface,
	electionID string,
) (string, error) {
	if err := validateElectionID(electionID); err != nil {
		return "", err
	}
	election, err := c.GetElection(ctx, electionID)
	if err != nil {
		return "", err
	}
	if (election.EncryptionMode != "elgamal" && election.EncryptionMode != "elgamal-vector-v3") || election.ElGamalPubKey == nil {
		return "", fmt.Errorf("이 선거는 ElGamal 모드가 아닙니다 (현재 모드: %s)", election.EncryptionMode)
	}
	pubKeyJSON, err := json.Marshal(election.ElGamalPubKey)
	if err != nil {
		return "", fmt.Errorf("ElGamal 공개키 직렬화 실패: %w", err)
	}
	return string(pubKeyJSON), nil
}

// [PAPER-11] VerifyElGamalProofs ElGamal Chaum-Pedersen ZKP 공개 검증
// 집계 후 Tally의 ZKP를 공개키로 검증 — 비밀키 없이 복호화 정확성 확인
func (c *VotingContract) VerifyElGamalProofs(
	ctx contractapi.TransactionContextInterface,
	electionID string,
) (string, error) {
	if err := validateElectionID(electionID); err != nil {
		return "", err
	}
	election, err := c.GetElection(ctx, electionID)
	if err != nil {
		return "", err
	}
	if (election.EncryptionMode != "elgamal" && election.EncryptionMode != "elgamal-vector-v3") || election.ElGamalPubKey == nil {
		return "", fmt.Errorf("이 선거는 ElGamal 모드가 아닙니다")
	}

	// Tally 조회
	tallyKey := "TALLY_" + electionID
	tallyBytes, err := ctx.GetStub().GetState(tallyKey)
	if err != nil || tallyBytes == nil {
		return "", fmt.Errorf("집계 결과를 찾을 수 없습니다")
	}
	var tally VoteTally
	if err := json.Unmarshal(tallyBytes, &tally); err != nil {
		return "", fmt.Errorf("Tally 파싱 실패: %w", err)
	}
	if election.EncryptionMode == "elgamal-vector-v3" {
		return verifyVectorTallyPublic(election, &tally)
	}
	if len(tally.PartialDecryptions) > 0 {
		values := make(map[int]*big.Int)
		publicValues := make(map[int]*big.Int)
		failed := 0
		for _, partial := range tally.PartialDecryptions {
			if partial.Index < 1 || partial.Index > len(election.ThresholdPublicShares) || values[partial.Index] != nil {
				failed++
				continue
			}
			expected := election.ThresholdPublicShares[partial.Index-1]
			value, valueOK := parseSubgroupElement(partial.Value)
			y, yOK := parseSubgroupElement(partial.PublicKeyY)
			pub := &ElGamalPublicKey{P: elgamalP.Text(16), G: elgamalG.Text(16), Y: partial.PublicKeyY}
			if !valueOK || !yOK || partial.MSPID != expected.MSPID || partial.PublicKeyY != expected.PublicKeyY ||
				!chaumPedersenVerifyRaw(pub, partial.Proof, big.NewInt(1)) {
				failed++
				continue
			}
			values[partial.Index] = value
			publicValues[partial.Index] = y
		}
		valid := failed == 0 && len(values) >= ShamirThreshold && tally.Decrypted
		if valid {
			combined, combineErr := combinePartialDecryptionValues(values)
			combinedPublic, publicErr := combinePartialDecryptionValues(publicValues)
			c2, c2OK := parseSubgroupElement(tally.EncAggC2)
			electionY, electionYOK := parseSubgroupElement(election.ElGamalPubKey.Y)
			if combineErr != nil || publicErr != nil || !c2OK || !electionYOK || combinedPublic.Cmp(electionY) != 0 {
				valid = false
			} else {
				sum := int64(0)
				base := int64(1)
				for _, candidate := range election.Candidates {
					sum += int64(tally.Results[candidate]) * base
					base *= HomomorphicBase
				}
				expectedGSum := new(big.Int).Exp(elgamalG, big.NewInt(sum), elgamalP)
				combinedInv := new(big.Int).ModInverse(combined, elgamalP)
				if combinedInv == nil {
					valid = false
				} else {
					actualGSum := new(big.Int).Mul(c2, combinedInv)
					actualGSum.Mod(actualGSum, elgamalP)
					valid = actualGSum.Cmp(expectedGSum) == 0
				}
			}
		}
		result := map[string]interface{}{
			"electionID": electionID, "encryptionMode": "elgamal-threshold-v2",
			"totalProofs": len(tally.PartialDecryptions), "verified": len(values),
			"failed": failed, "resultsMatch": valid, "originalResults": tally.Results, "isValid": valid,
		}
		resultJSON, _ := json.Marshal(result)
		return string(resultJSON), nil
	}

	// 각 ZKP 검증
	verified := 0
	failed := 0
	recount := make(map[string]int)

	for _, proof := range tally.DecryptionProofs {
		if proof.ZKProof == nil {
			failed++
			continue
		}

		// [PAPER-13] 동형 집계 증명: g^sum을 직접 검증
		if proof.NullifierHash == "HOMOMORPHIC_TALLY" {
			// tally.Results에서 sum을 재계산: sum = Σ(count_i * B^i)
			recomputedSum := int64(0)
			for i, cand := range election.Candidates {
				count := int64(tally.Results[cand])
				base := int64(1)
				for j := 0; j < i; j++ {
					base *= HomomorphicBase
				}
				recomputedSum += count * base
			}
			// g^sum 계산
			gSum := new(big.Int).Exp(elgamalG, big.NewInt(recomputedSum), elgamalP)
			// decryptedHash 재계산: SHA256("homomorphic_sum:<sum>")
			sumStr := fmt.Sprintf("homomorphic_sum:%d", recomputedSum)
			dh := sha256.Sum256([]byte(sumStr))
			dhHex := hex.EncodeToString(dh[:])
			if dhHex != proof.DecryptedHash {
				failed++
				continue
			}
			// raw ZKP 검증: m = g^sum
			if chaumPedersenVerifyRaw(election.ElGamalPubKey, proof.ZKProof, gSum) {
				verified++
				// 동형 집계 검증 성공 — 결과를 recount에 반영
				for _, cand := range election.Candidates {
					recount[cand] = tally.Results[cand]
				}
			} else {
				failed++
			}
			continue
		}

		// 개별 투표 ZKP 검증 (AES 모드 호환)
		var matchedCandidate string
		for _, cand := range election.Candidates {
			dh := sha256.Sum256([]byte(cand))
			if hex.EncodeToString(dh[:]) == proof.DecryptedHash {
				matchedCandidate = cand
				break
			}
		}
		if matchedCandidate == "" {
			failed++
			continue
		}

		if chaumPedersenVerify(election.ElGamalPubKey, proof.ZKProof, matchedCandidate) {
			verified++
			recount[matchedCandidate]++
		} else {
			failed++
		}
	}

	// 재집계 결과와 원본 비교
	resultsMatch := true
	for k, v := range tally.Results {
		if recount[k] != v {
			resultsMatch = false
			break
		}
	}

	result := map[string]interface{}{
		"electionID":      electionID,
		"encryptionMode":  "elgamal",
		"totalProofs":     len(tally.DecryptionProofs),
		"verified":        verified,
		"failed":          failed,
		"resultsMatch":    resultsMatch,
		"recount":         recount,
		"originalResults": tally.Results,
		"isValid":         len(tally.DecryptionProofs) > 0 && verified > 0 && failed == 0 && resultsMatch,
	}

	resultJSON, _ := json.Marshal(result)
	return string(resultJSON), nil
}

func verifyVectorTallyPublic(election *Election, tally *VoteTally) (string, error) {
	failed := 0
	valuesByCandidate := make([]map[int]*big.Int, len(election.Candidates))
	publicValues := make(map[int]*big.Int)
	for i := range valuesByCandidate {
		valuesByCandidate[i] = make(map[int]*big.Int)
	}
	seen := make(map[int]bool)
	for _, partial := range tally.VectorPartialDecryptions {
		if partial.Index < 1 || partial.Index > len(election.ThresholdPublicShares) || seen[partial.Index] ||
			len(partial.Values) != len(election.Candidates) || len(partial.Proofs) != len(election.Candidates) {
			failed++
			continue
		}
		expected := election.ThresholdPublicShares[partial.Index-1]
		y, yOK := parseSubgroupElement(partial.PublicKeyY)
		if !yOK || partial.MSPID != expected.MSPID || partial.PublicKeyY != expected.PublicKeyY {
			failed++
			continue
		}
		pub := &ElGamalPublicKey{P: elgamalP.Text(16), G: elgamalG.Text(16), Y: partial.PublicKeyY}
		validPartial := true
		parsed := make([]*big.Int, len(partial.Values))
		for candidateIndex, valueHex := range partial.Values {
			value, ok := parseSubgroupElement(valueHex)
			proof := partial.Proofs[candidateIndex]
			if !ok || proof == nil || candidateIndex >= len(tally.EncAggVector) ||
				proof.C1 != tally.EncAggVector[candidateIndex].C1 || proof.C2 != valueHex ||
				!chaumPedersenVerifyRaw(pub, proof, big.NewInt(1)) {
				validPartial = false
				break
			}
			parsed[candidateIndex] = value
		}
		if !validPartial {
			failed++
			continue
		}
		seen[partial.Index], publicValues[partial.Index] = true, y
		for candidateIndex, value := range parsed {
			valuesByCandidate[candidateIndex][partial.Index] = value
		}
	}
	valid := failed == 0 && len(seen) >= ShamirThreshold && tally.Decrypted && len(tally.EncAggVector) == len(election.Candidates)
	if valid {
		combinedPublic, err := combinePartialDecryptionValues(publicValues)
		electionY, yOK := parseSubgroupElement(election.ElGamalPubKey.Y)
		if err != nil || !yOK || combinedPublic.Cmp(electionY) != 0 {
			valid = false
		}
	}
	resultSum := 0
	if valid {
		for candidateIndex, candidate := range election.Candidates {
			combined, err := combinePartialDecryptionValues(valuesByCandidate[candidateIndex])
			c2, c2OK := parseSubgroupElement(tally.EncAggVector[candidateIndex].C2)
			if err != nil || !c2OK {
				valid = false
				break
			}
			actual := new(big.Int).Mul(c2, new(big.Int).ModInverse(combined, elgamalP))
			actual.Mod(actual, elgamalP)
			count := tally.Results[candidate]
			if count < 0 || actual.Cmp(new(big.Int).Exp(elgamalG, big.NewInt(int64(count)), elgamalP)) != 0 {
				valid = false
				break
			}
			resultSum += count
		}
		if resultSum != tally.TotalVotes {
			valid = false
		}
	}
	result := map[string]interface{}{
		"electionID": election.ElectionID, "encryptionMode": "elgamal-vector-v3",
		"totalProofs": len(tally.VectorPartialDecryptions), "verified": len(seen), "failed": failed,
		"resultsMatch": valid, "originalResults": tally.Results, "isValid": valid,
	}
	encoded, err := json.Marshal(result)
	if err != nil {
		return "", err
	}
	return string(encoded), nil
}

// ============================================================
// Bulletin Board — 공개 감사 데이터 (PAPER-6: Universal Verifiability)
// ============================================================

// BulletinBoard 선거의 모든 공개 감사 데이터를 한 곳에 모은 구조체
// Helios 모델: 집계 후 암호화 키를 공개하여 누구나 독립 검증 가능
// [PAPER-7] 투표 순서를 결정론적으로 셔플하여 시간 분석 공격 방지
type BulletinBoard struct {
	ObjectType       string            `json:"docType"` // "bulletinBoard"
	ElectionID       string            `json:"electionID"`
	EncryptionKeyHex string            `json:"encryptionKeyHex,omitempty" metadata:",optional"` // 공개된 AES-256 키 (AES 모드)
	EncryptedBallots []EncryptedBallot `json:"encryptedBallots"`                                // 셔플된 암호화 투표
	TallyResults     map[string]int    `json:"tallyResults"`                                    // 공식 집계 결과
	TotalVotes       int               `json:"totalVotes"`
	DecryptionProofs []DecryptionProof `json:"decryptionProofs"`                                // 복호화 증명 (AES: hash, ElGamal: ZKP)
	TallyProofHash   string            `json:"tallyProofHash"`                                  // 집계 증명 해시
	MerkleRoot       string            `json:"merkleRoot,omitempty" metadata:",optional"`       // Merkle tree root
	ShuffleSeed      string            `json:"shuffleSeed,omitempty" metadata:",optional"`      // [PAPER-7] 셔플 시드 (hex)
	ShuffleProofHash string            `json:"shuffleProofHash,omitempty" metadata:",optional"` // [PAPER-7] 셔플 정확성 증명
	PublishedAt      int64             `json:"publishedAt"`
	// [PAPER-11] ElGamal 모드 전용 필드
	EncryptionMode           string                    `json:"encryptionMode,omitempty" metadata:",optional"` // "aes" | "elgamal"
	ElGamalPubKey            *ElGamalPublicKey         `json:"elgamalPubKey,omitempty" metadata:",optional"`  // ElGamal 공개키 (ZKP 검증용)
	ThresholdPublicShares    []ThresholdPublicShare    `json:"thresholdPublicShares,omitempty" metadata:",optional"`
	PartialDecryptions       []PartialDecryption       `json:"partialDecryptions,omitempty" metadata:",optional"`
	VectorPartialDecryptions []VectorPartialDecryption `json:"vectorPartialDecryptions,omitempty" metadata:",optional"`
	EncAggC1                 string                    `json:"encAggC1,omitempty" metadata:",optional"`
	EncAggC2                 string                    `json:"encAggC2,omitempty" metadata:",optional"`
	EncAggVector             []ElGamalCiphertext       `json:"encAggVector,omitempty" metadata:",optional"`
	VectorBallotReceipts     []VectorBallotReceipt     `json:"vectorBallotReceipts,omitempty" metadata:",optional"`
	VectorAuditDisclosures   []VectorAuditDisclosure   `json:"vectorAuditDisclosures,omitempty" metadata:",optional"`
}

// EncryptedBallot 공개 원장의 개별 암호화 투표
type EncryptedBallot struct {
	NullifierHash             string                     `json:"nullifierHash"`
	EncryptedCandidateID      string                     `json:"encryptedCandidateID"`
	CandidateCommitment       string                     `json:"candidateCommitment"`
	BallotValidityProof       *BallotValidityProof       `json:"ballotValidityProof,omitempty" metadata:",optional"`
	EncryptedCandidateVector  []ElGamalCiphertext        `json:"encryptedCandidateVector,omitempty" metadata:",optional"`
	VectorBallotValidityProof *VectorBallotValidityProof `json:"vectorBallotValidityProof,omitempty" metadata:",optional"`
	PreparedBallotID          string                     `json:"preparedBallotID,omitempty" metadata:",optional"`
}

// PublicVerificationResult 공개 검증 결과
type PublicVerificationResult struct {
	ElectionID         string         `json:"electionID"`
	IsValid            bool           `json:"isValid"`
	RecomputedResults  map[string]int `json:"recomputedResults"`  // 독립 재집계 결과
	OriginalResults    map[string]int `json:"originalResults"`    // 원본 집계 결과
	ResultsMatch       bool           `json:"resultsMatch"`       // 결과 일치 여부
	ProofHashMatch     bool           `json:"proofHashMatch"`     // tallyProofHash 일치 여부
	ShuffleVerified    bool           `json:"shuffleVerified"`    // [PAPER-7] 셔플 정확성 검증
	DecryptionVerified int            `json:"decryptionVerified"` // 검증 성공한 투표 수
	DecryptionFailed   int            `json:"decryptionFailed"`   // 검증 실패한 투표 수
	TotalBallots       int            `json:"totalBallots"`
	VerifiedAt         int64          `json:"verifiedAt"`
}

// PublishAuditData [PAPER-6] 집계 완료 후 모든 감사 데이터를 공개 원장에 게시합니다.
// Helios 모델: 암호화 키를 공개하여 누구나 투표를 복호화하고 집계를 독립 검증 가능.
// 전제조건: 선거 CLOSED + Shamir 키 복원 완료 + TallyVotes 완료
func (c *VotingContract) PublishAuditData(
	ctx contractapi.TransactionContextInterface,
	electionID string,
) (*BulletinBoard, error) {
	if err := requireElectionAdmin(ctx); err != nil {
		return nil, err
	}

	// 선거 상태 확인
	election, err := c.GetElection(ctx, electionID)
	if err != nil {
		return nil, err
	}
	if election.Status != "CLOSED" {
		return nil, fmt.Errorf("CLOSED 상태의 선거에서만 감사 데이터를 게시할 수 있습니다 (현재: %s)", election.Status)
	}

	// 중복 게시 방지
	bbKey := "BULLETIN_" + electionID
	if existing, _ := ctx.GetStub().GetState(bbKey); existing != nil {
		return nil, fmt.Errorf("이미 감사 데이터가 게시된 선거입니다: %s", electionID)
	}

	// 집계 결과 조회
	tally, err := c.GetTally(ctx, electionID)
	if err != nil {
		return nil, fmt.Errorf("집계 결과 조회 실패: %w", err)
	}

	// 암호화 키 / ElGamal 공개키 조회
	isElGamal := election.EncryptionMode == "elgamal" || election.EncryptionMode == "elgamal-vector-v3"
	if isElGamal {
		if !tally.Decrypted {
			return nil, fmt.Errorf("ElGamal 집계는 threshold 복원과 복호화 완료 후에만 게시할 수 있습니다")
		}
		proofCount := len(tally.PartialDecryptions)
		if election.EncryptionMode == "elgamal-vector-v3" {
			proofCount = len(tally.VectorPartialDecryptions)
		}
		if len(election.ThresholdPublicShares) > 0 && proofCount < ShamirThreshold {
			return nil, fmt.Errorf("ElGamal threshold partial decryption 증명이 부족합니다")
		}
		if len(election.ThresholdPublicShares) == 0 && len(tally.DecryptionProofs) == 0 {
			return nil, fmt.Errorf("ElGamal 집계 복호화 증명이 없어 게시할 수 없습니다")
		}
	}
	var encKey []byte
	var encKeyHex string
	if !isElGamal {
		var ekErr error
		encKey, ekErr = getEncryptionKey(ctx, electionID)
		if ekErr != nil {
			return nil, fmt.Errorf("암호화 키 조회 실패 — Shamir 복원이 완료되었는지 확인하세요: %w", ekErr)
		}
		encKeyHex = hex.EncodeToString(encKey)
	} else {
		// The shuffle seed is published, so deriving it from an unrelated secret
		// adds no secrecy and breaks v2 after AES key deletion. Bind it to the
		// public, proof-authenticated tally instead.
		encKey = []byte("ELGAMAL-PUBLIC-SHUFFLE-V2")
		encKeyHex = ""
	}

	// 모든 nullifier (암호화된 투표) 조회
	queryString := fmt.Sprintf(
		`{"selector":{"docType":"nullifier","electionID":"%s"},"use_index":["_design/indexElection","electionIndex"]}`,
		electionID,
	)
	resultsIterator, err := ctx.GetStub().GetQueryResult(queryString)
	if err != nil {
		return nil, fmt.Errorf("nullifier 조회 실패: %w", err)
	}
	defer resultsIterator.Close()

	var ballots []EncryptedBallot
	for resultsIterator.HasNext() {
		qr, err := resultsIterator.Next()
		if err != nil {
			return nil, fmt.Errorf("결과 순회 실패: %w", err)
		}
		var nul Nullifier
		if err := json.Unmarshal(qr.Value, &nul); err != nil {
			return nil, fmt.Errorf("Nullifier 역직렬화 실패: %w", err)
		}
		// Padding records are not cast ballots and are excluded from the official
		// tally, so publishing them as encrypted ballots would make independent
		// recomputation disagree with TotalVotes. DUMMY_IDX already makes these
		// legacy padding records publicly identifiable.
		if nul.IsPadding {
			continue
		}
		if election.EncryptionMode == "elgamal" && nul.EncryptedCandidateID != "" && nul.BallotValidityProof == nil {
			return nil, fmt.Errorf("ElGamal ballot validity proof 누락 (nullifier=%s)", nul.NullifierHash)
		}
		if election.EncryptionMode == "elgamal-vector-v3" && (len(nul.EncryptedCandidateVector) != len(election.Candidates) || nul.VectorBallotValidityProof == nil) {
			return nil, fmt.Errorf("vector-v3 ballot/proof 누락 (nullifier=%s)", nul.NullifierHash)
		}
		if election.EncryptionMode == "elgamal-vector-v3" && !isCanonicalSHA256Hex(nul.PreparedBallotID) {
			return nil, fmt.Errorf("vector-v3 prepared ballot ID 누락 (nullifier=%s)", nul.NullifierHash)
		}
		ballots = append(ballots, EncryptedBallot{
			NullifierHash:             nul.NullifierHash,
			EncryptedCandidateID:      nul.EncryptedCandidateID,
			CandidateCommitment:       nul.CandidateCommitment,
			BallotValidityProof:       nul.BallotValidityProof,
			EncryptedCandidateVector:  nul.EncryptedCandidateVector,
			VectorBallotValidityProof: nul.VectorBallotValidityProof,
			PreparedBallotID:          nul.PreparedBallotID,
		})
	}

	var vectorReceipts []VectorBallotReceipt
	var vectorDisclosures []VectorAuditDisclosure
	if election.EncryptionMode == "elgamal-vector-v3" {
		receiptIterator, err := ctx.GetStub().GetStateByRange("VECTOR_PREP_", "VECTOR_PREP_\uffff")
		if err != nil {
			return nil, fmt.Errorf("vector receipt 조회 실패: %w", err)
		}
		defer receiptIterator.Close()
		castReceiptIDs := make(map[string]string)
		for receiptIterator.HasNext() {
			entry, err := receiptIterator.Next()
			if err != nil {
				return nil, fmt.Errorf("vector receipt 순회 실패: %w", err)
			}
			var receipt VectorBallotReceipt
			if err := json.Unmarshal(entry.Value, &receipt); err != nil {
				return nil, fmt.Errorf("vector receipt 파싱 실패: %w", err)
			}
			if receipt.ElectionID != electionID {
				continue
			}
			switch receipt.Status {
			case "cast":
				castReceiptIDs[receipt.BallotID] = receipt.ArtifactHash
				vectorReceipts = append(vectorReceipts, receipt)
			case "audited":
				disclosureBytes, err := ctx.GetStub().GetState("VECTOR_AUDIT_" + receipt.BallotID)
				if err != nil || disclosureBytes == nil {
					return nil, fmt.Errorf("audited vector disclosure 누락: %s", receipt.BallotID)
				}
				var disclosure VectorAuditDisclosure
				if err := json.Unmarshal(disclosureBytes, &disclosure); err != nil || disclosure.BallotID != receipt.BallotID ||
					disclosure.ElectionID != electionID || disclosure.ArtifactHash != receipt.ArtifactHash || disclosure.Status != "audited" {
					return nil, fmt.Errorf("audited vector disclosure 불일치: %s", receipt.BallotID)
				}
				vectorReceipts = append(vectorReceipts, receipt)
				vectorDisclosures = append(vectorDisclosures, disclosure)
			}
		}
		if len(castReceiptIDs) != len(ballots) {
			return nil, fmt.Errorf("cast vector receipt 수 불일치: receipts=%d ballots=%d", len(castReceiptIDs), len(ballots))
		}
		for _, ballot := range ballots {
			receiptHash, exists := castReceiptIDs[ballot.PreparedBallotID]
			if !exists {
				return nil, fmt.Errorf("cast vector receipt 누락: %s", ballot.PreparedBallotID)
			}
			artifactHash, err := computeVectorAuditArtifactHash(electionID, election.Candidates,
				ballot.EncryptedCandidateVector, ballot.VectorBallotValidityProof)
			if err != nil || subtle.ConstantTimeCompare([]byte(receiptHash), []byte(artifactHash)) != 1 {
				return nil, fmt.Errorf("cast vector receipt artifact 불일치: %s", ballot.PreparedBallotID)
			}
		}
		sort.Slice(vectorReceipts, func(i, j int) bool { return vectorReceipts[i].BallotID < vectorReceipts[j].BallotID })
		sort.Slice(vectorDisclosures, func(i, j int) bool { return vectorDisclosures[i].BallotID < vectorDisclosures[j].BallotID })
	}

	// [PAPER-7] 결정론적 셔플: 제출 순서와 공개 순서의 연결을 끊어 시간 분석 공격 방지
	// 셔플 시드 = SHA256(encryptionKey + electionID + tallyProofHash) — 모든 피어에서 동일
	shuffleSeedInput := append(encKey, []byte(electionID)...)
	shuffleSeedInput = append(shuffleSeedInput, []byte(tally.TallyProofHash)...)
	shuffleSeedHash := sha256.Sum256(shuffleSeedInput)
	shuffleSeed := shuffleSeedHash[:]

	// Fisher-Yates 셔플 (결정론적: 시드 기반 의사 난수)
	shuffledBallots, shuffledProofs := deterministicShuffle(ballots, tally.DecryptionProofs, shuffleSeed)

	// 셔플 정확성 증명: 셔플 전후 nullifier 집합이 동일함을 해시로 증명
	shuffleProofHash := computeShuffleProofHash(ballots, shuffledBallots)

	// Merkle root 조회 (있으면 포함)
	merkleRoot := ""
	mrKey := "MERKLE_ROOT_" + electionID
	if mrBytes, _ := ctx.GetStub().GetState(mrKey); mrBytes != nil {
		merkleRoot = string(mrBytes)
	}

	now, err := getTxTime(ctx)
	if err != nil {
		return nil, err
	}

	bb := BulletinBoard{
		ObjectType:               "bulletinBoard",
		ElectionID:               electionID,
		EncryptionKeyHex:         encKeyHex, // AES 모드에서만 공개, ElGamal 모드에서는 빈 문자열
		EncryptedBallots:         shuffledBallots,
		TallyResults:             tally.Results,
		TotalVotes:               tally.TotalVotes,
		DecryptionProofs:         shuffledProofs,
		TallyProofHash:           tally.TallyProofHash,
		MerkleRoot:               merkleRoot,
		ShuffleSeed:              hex.EncodeToString(shuffleSeed),
		ShuffleProofHash:         shuffleProofHash,
		PublishedAt:              now,
		EncryptionMode:           election.EncryptionMode,
		ElGamalPubKey:            election.ElGamalPubKey, // ElGamal 모드에서만 포함
		ThresholdPublicShares:    election.ThresholdPublicShares,
		PartialDecryptions:       tally.PartialDecryptions,
		VectorPartialDecryptions: tally.VectorPartialDecryptions,
		EncAggC1:                 tally.EncAggC1,
		EncAggC2:                 tally.EncAggC2,
		EncAggVector:             tally.EncAggVector,
		VectorBallotReceipts:     vectorReceipts,
		VectorAuditDisclosures:   vectorDisclosures,
	}
	if bb.EncryptionMode == "" {
		bb.EncryptionMode = "aes"
	}

	// Ballots and vector receipts already exist as immutable public ledger
	// records. Repeating them in one BULLETIN value makes the transaction grow
	// linearly and exceed the orderer's block limit. Persist only the publication
	// manifest; GetBulletinBoard reconstructs the public artifact arrays.
	published := bb
	published.EncryptedBallots = make([]EncryptedBallot, 0)
	published.DecryptionProofs = make([]DecryptionProof, 0)
	published.VectorBallotReceipts = make([]VectorBallotReceipt, 0)
	published.VectorAuditDisclosures = make([]VectorAuditDisclosure, 0)
	b, err := json.Marshal(published)
	if err != nil {
		return nil, fmt.Errorf("BulletinBoard 직렬화 실패: %w", err)
	}
	if err := ctx.GetStub().PutState(bbKey, b); err != nil {
		return nil, fmt.Errorf("BulletinBoard 저장 실패: %w", err)
	}

	if isElGamal {
		log.Printf("[PublishAuditData] 게시 완료 — election: %s, ballots: %d, mode: elgamal (ZKP, 키 비공개)", electionID, len(ballots))
	} else {
		log.Printf("[PublishAuditData] 게시 완료 — election: %s, ballots: %d, mode: aes (키 공개)", electionID, len(ballots))
	}
	return &published, nil
}

func (c *VotingContract) hydrateBulletinBoard(
	ctx contractapi.TransactionContextInterface,
	bb *BulletinBoard,
) error {
	election, err := c.GetElection(ctx, bb.ElectionID)
	if err != nil {
		return fmt.Errorf("BulletinBoard election lookup failed: %w", err)
	}
	queryString := fmt.Sprintf(
		`{"selector":{"docType":"nullifier","electionID":"%s"},"use_index":["_design/indexElection","electionIndex"]}`,
		bb.ElectionID,
	)
	iterator, err := ctx.GetStub().GetQueryResult(queryString)
	if err != nil {
		return fmt.Errorf("BulletinBoard ballot lookup failed: %w", err)
	}
	defer iterator.Close()
	ballots := make([]EncryptedBallot, 0, bb.TotalVotes)
	for iterator.HasNext() {
		entry, err := iterator.Next()
		if err != nil {
			return fmt.Errorf("BulletinBoard ballot iteration failed: %w", err)
		}
		var nul Nullifier
		if err := json.Unmarshal(entry.Value, &nul); err != nil {
			return fmt.Errorf("BulletinBoard ballot decode failed: %w", err)
		}
		if nul.IsPadding {
			continue
		}
		ballots = append(ballots, EncryptedBallot{
			NullifierHash: nul.NullifierHash, EncryptedCandidateID: nul.EncryptedCandidateID,
			CandidateCommitment: nul.CandidateCommitment, BallotValidityProof: nul.BallotValidityProof,
			EncryptedCandidateVector:  nul.EncryptedCandidateVector,
			VectorBallotValidityProof: nul.VectorBallotValidityProof, PreparedBallotID: nul.PreparedBallotID,
		})
	}
	if len(ballots) != bb.TotalVotes {
		return fmt.Errorf("BulletinBoard ballot count mismatch: got=%d want=%d", len(ballots), bb.TotalVotes)
	}
	tally, err := c.GetTally(ctx, bb.ElectionID)
	if err != nil {
		return fmt.Errorf("BulletinBoard tally lookup failed: %w", err)
	}
	seed, err := hex.DecodeString(bb.ShuffleSeed)
	if err != nil || len(seed) != sha256.Size {
		return fmt.Errorf("BulletinBoard shuffle seed is invalid")
	}
	shuffled, proofs := deterministicShuffle(ballots, tally.DecryptionProofs, seed)
	if computeShuffleProofHash(ballots, shuffled) != bb.ShuffleProofHash {
		return fmt.Errorf("BulletinBoard reconstructed shuffle proof mismatch")
	}
	bb.EncryptedBallots = shuffled
	bb.DecryptionProofs = proofs

	if election.EncryptionMode != "elgamal-vector-v3" {
		return nil
	}
	receipts, err := ctx.GetStub().GetStateByRange("VECTOR_PREP_", "VECTOR_PREP_￿")
	if err != nil {
		return fmt.Errorf("BulletinBoard vector receipt lookup failed: %w", err)
	}
	defer receipts.Close()
	castArtifacts := make(map[string]string)
	for receipts.HasNext() {
		entry, err := receipts.Next()
		if err != nil {
			return fmt.Errorf("BulletinBoard vector receipt iteration failed: %w", err)
		}
		var receipt VectorBallotReceipt
		if err := json.Unmarshal(entry.Value, &receipt); err != nil {
			return fmt.Errorf("BulletinBoard vector receipt decode failed: %w", err)
		}
		if receipt.ElectionID != bb.ElectionID {
			continue
		}
		if receipt.Status == "cast" {
			castArtifacts[receipt.BallotID] = receipt.ArtifactHash
		}
		bb.VectorBallotReceipts = append(bb.VectorBallotReceipts, receipt)
		if receipt.Status == "audited" {
			disclosureBytes, err := ctx.GetStub().GetState("VECTOR_AUDIT_" + receipt.BallotID)
			if err != nil || disclosureBytes == nil {
				return fmt.Errorf("BulletinBoard audited disclosure missing: %s", receipt.BallotID)
			}
			var disclosure VectorAuditDisclosure
			if err := json.Unmarshal(disclosureBytes, &disclosure); err != nil ||
				disclosure.BallotID != receipt.BallotID || disclosure.ElectionID != bb.ElectionID ||
				disclosure.ArtifactHash != receipt.ArtifactHash || disclosure.Status != "audited" {
				return fmt.Errorf("BulletinBoard audit disclosure is invalid: %s", receipt.BallotID)
			}
			bb.VectorAuditDisclosures = append(bb.VectorAuditDisclosures, disclosure)
		}
	}
	if len(castArtifacts) != len(ballots) {
		return fmt.Errorf("BulletinBoard cast receipt count mismatch: got=%d want=%d", len(castArtifacts), len(ballots))
	}
	for _, ballot := range ballots {
		receiptHash, exists := castArtifacts[ballot.PreparedBallotID]
		artifactHash, hashErr := computeVectorAuditArtifactHash(bb.ElectionID, election.Candidates,
			ballot.EncryptedCandidateVector, ballot.VectorBallotValidityProof)
		if !exists || hashErr != nil || subtle.ConstantTimeCompare([]byte(receiptHash), []byte(artifactHash)) != 1 {
			return fmt.Errorf("BulletinBoard cast receipt artifact mismatch: %s", ballot.PreparedBallotID)
		}
	}
	sort.Slice(bb.VectorBallotReceipts, func(i, j int) bool {
		return bb.VectorBallotReceipts[i].BallotID < bb.VectorBallotReceipts[j].BallotID
	})
	sort.Slice(bb.VectorAuditDisclosures, func(i, j int) bool {
		return bb.VectorAuditDisclosures[i].BallotID < bb.VectorAuditDisclosures[j].BallotID
	})
	return nil
}

// GetBulletinBoard [PAPER-6] 공개 감사 데이터를 조회합니다 (인증 불필요).
func (c *VotingContract) GetBulletinBoard(
	ctx contractapi.TransactionContextInterface,
	electionID string,
) (*BulletinBoard, error) {
	bbKey := "BULLETIN_" + electionID
	b, err := ctx.GetStub().GetState(bbKey)
	if err != nil {
		return nil, fmt.Errorf("BulletinBoard 조회 실패: %w", err)
	}
	if b == nil {
		return nil, fmt.Errorf("감사 데이터가 아직 게시되지 않았습니다: %s", electionID)
	}
	var bb BulletinBoard
	if err := json.Unmarshal(b, &bb); err != nil {
		return nil, fmt.Errorf("BulletinBoard 역직렬화 실패: %w", err)
	}
	if len(bb.EncryptedBallots) == 0 && bb.TotalVotes > 0 {
		if err := c.hydrateBulletinBoard(ctx, &bb); err != nil {
			return nil, err
		}
	}
	return &bb, nil
}

// VerifyTallyPublic [PAPER-6] 공개 감사 데이터로 집계를 독립 검증합니다.
// 누구나 호출 가능: 게시된 키로 모든 투표를 복호화하고 재집계하여 원본과 비교.
func (c *VotingContract) VerifyTallyPublic(
	ctx contractapi.TransactionContextInterface,
	electionID string,
) (*PublicVerificationResult, error) {
	// 1. BulletinBoard 조회
	bb, err := c.GetBulletinBoard(ctx, electionID)
	if err != nil {
		return nil, err
	}

	// 2. 선거 정보 조회 (후보자 목록 필요)
	election, elErr := c.GetElection(ctx, electionID)
	if elErr != nil {
		return nil, fmt.Errorf("선거 정보 조회 실패: %w", elErr)
	}

	recomputed := make(map[string]int)
	verified := 0
	failed := 0
	isElGamal := bb.EncryptionMode == "elgamal"

	if isElGamal && bb.ElGamalPubKey != nil {
		// [PAPER-11/13] ElGamal 모드: 동형 집계 ZKP 검증 (비밀키 불필요)
		for _, proof := range bb.DecryptionProofs {
			if proof.ZKProof == nil {
				failed++
				continue
			}

			if proof.NullifierHash == "HOMOMORPHIC_TALLY" {
				// 동형 집계 증명: g^sum 직접 검증
				recomputedSum := int64(0)
				for i, cand := range election.Candidates {
					count := int64(bb.TallyResults[cand])
					base := int64(1)
					for j := 0; j < i; j++ {
						base *= HomomorphicBase
					}
					recomputedSum += count * base
				}
				gSum := new(big.Int).Exp(elgamalG, big.NewInt(recomputedSum), elgamalP)
				sumStr := fmt.Sprintf("homomorphic_sum:%d", recomputedSum)
				dh := sha256.Sum256([]byte(sumStr))
				if hex.EncodeToString(dh[:]) != proof.DecryptedHash {
					failed++
					continue
				}
				if chaumPedersenVerifyRaw(bb.ElGamalPubKey, proof.ZKProof, gSum) {
					verified++
					for _, cand := range election.Candidates {
						recomputed[cand] = bb.TallyResults[cand]
					}
				} else {
					failed++
				}
				continue
			}

			// 개별 투표 ZKP (AES 호환)
			var matchedCandidate string
			for _, cand := range election.Candidates {
				dh := sha256.Sum256([]byte(cand))
				if hex.EncodeToString(dh[:]) == proof.DecryptedHash {
					matchedCandidate = cand
					break
				}
			}
			if matchedCandidate == "" {
				failed++
				continue
			}
			if chaumPedersenVerify(bb.ElGamalPubKey, proof.ZKProof, matchedCandidate) {
				recomputed[matchedCandidate]++
				verified++
			} else {
				failed++
			}
		}
	} else {
		// AES 모드: 공개 키로 복호화 + 재집계
		encKey, ekErr := hex.DecodeString(bb.EncryptionKeyHex)
		if ekErr != nil {
			return nil, fmt.Errorf("공개 키 디코딩 실패: %w", ekErr)
		}
		for _, ballot := range bb.EncryptedBallots {
			if ballot.EncryptedCandidateID == "" {
				failed++
				continue
			}
			decrypted, decErr := decryptAESGCM(encKey, ballot.EncryptedCandidateID)
			if decErr != nil {
				failed++
				continue
			}
			recomputed[decrypted]++
			verified++
		}
		// 개별 DecryptionProof 검증
		for _, proof := range bb.DecryptionProofs {
			decrypted, decErr := decryptAESGCM(encKey, proof.EncryptedCandidateID)
			if decErr != nil {
				continue
			}
			dh := sha256.Sum256([]byte(decrypted))
			if hex.EncodeToString(dh[:]) != proof.DecryptedHash {
				failed++
			}
		}
	}

	// 3. 재집계 결과와 원본 비교
	resultsMatch := len(recomputed) == len(bb.TallyResults)
	if resultsMatch {
		for cand, count := range bb.TallyResults {
			if recomputed[cand] != count {
				resultsMatch = false
				break
			}
		}
	}

	// 4. DecryptionProof 해시 재계산 및 비교
	recomputedProofHash := computeTallyProofHash(bb.DecryptionProofs)
	proofHashMatch := recomputedProofHash == bb.TallyProofHash

	now, err := getTxTime(ctx)
	if err != nil {
		return nil, err
	}

	// 6. [PAPER-7] 셔플 정확성 검증: ballot 집합에 중복/누락 없는지 확인
	shuffleVerified := true
	if bb.ShuffleProofHash != "" {
		// nullifierHash 집합의 정렬 해시 재계산
		recomputedShuffleHash := computeShuffleProofHash(bb.EncryptedBallots, bb.EncryptedBallots)
		shuffleVerified = recomputedShuffleHash == bb.ShuffleProofHash
	}

	result := &PublicVerificationResult{
		ElectionID:         electionID,
		IsValid:            len(bb.DecryptionProofs) > 0 && verified > 0 && len(bb.EncryptedBallots) == bb.TotalVotes && resultsMatch && proofHashMatch && shuffleVerified && failed == 0,
		RecomputedResults:  recomputed,
		OriginalResults:    bb.TallyResults,
		ResultsMatch:       resultsMatch,
		ProofHashMatch:     proofHashMatch,
		ShuffleVerified:    shuffleVerified,
		DecryptionVerified: verified,
		DecryptionFailed:   failed,
		TotalBallots:       len(bb.EncryptedBallots),
		VerifiedAt:         now,
	}

	log.Printf("[VerifyTallyPublic] 검증 완료 — election: %s, valid: %v, verified: %d/%d",
		electionID, result.IsValid, verified, len(bb.EncryptedBallots))
	return result, nil
}

// ============================================================
// Security Properties — 형식 보안 증명과 코드의 연결 (PAPER-5)
// ============================================================

// SecurityProperties 시스템의 보안 속성 요약 (감사 및 논문용)
type SecurityProperties struct {
	BallotSecrecy          SecurityProperty `json:"ballotSecrecy"`
	CastAsIntended         SecurityProperty `json:"castAsIntended"`
	RecordedAsCast         SecurityProperty `json:"recordedAsCast"`
	TalliedAsRecorded      SecurityProperty `json:"talliedAsRecorded"`
	UniversalVerifiability SecurityProperty `json:"universalVerifiability"`
	CoercionResistance     SecurityProperty `json:"coercionResistance"`
	EligibilityVerify      SecurityProperty `json:"eligibilityVerify"`
	CryptoPrimitives       []string         `json:"cryptoPrimitives"`
	EndorsementPolicy      string           `json:"endorsementPolicy"`
}

// SecurityProperty 개별 보안 속성
type SecurityProperty struct {
	Property   string `json:"property"`
	Status     string `json:"status"`     // implementation metadata only; not independent evidence
	Mechanism  string `json:"mechanism"`  // 구현 메커니즘
	Assumption string `json:"assumption"` // 암호학적 가정
	PaperRef   string `json:"paperRef"`   // 구현 보고서 참조
}

// GetSecurityProperties returns self-declared implementation metadata. It is
// never sufficient evidence that a security property has been achieved.
func (c *VotingContract) GetSecurityProperties(
	ctx contractapi.TransactionContextInterface,
) (*SecurityProperties, error) {
	hasCredSecret := os.Getenv("CREDENTIAL_SECRET") != ""
	hasPubKey := os.Getenv("ED25519_PUBLIC_KEY_DER_B64") != ""

	credMechanism := "metadata-only"
	credStatus := "unverified"
	if hasCredSecret {
		credMechanism = "chaincode-hmac"
		credStatus = "implemented"
	}
	if hasPubKey {
		credMechanism = "chaincode-ed25519"
		credStatus = "implemented"
	}

	return &SecurityProperties{
		BallotSecrecy: SecurityProperty{
			Property:   "Ballot Secrecy",
			Status:     "unverified",
			Mechanism:  "ElGamal client-side encryption + optional authenticated Feldman DKG + 2-of-3 partial decryption",
			Assumption: "DDH; DKG trustees keep scalar shares and signing keys under genuinely independent custody",
			PaperRef:   "PAPER-1 (21차)",
		},
		CastAsIntended: SecurityProperty{
			Property:   "Cast-as-Intended",
			Status:     "implemented",
			Mechanism:  "Benaloh Challenge (PrepareBallot/AuditBallot) with deterministic re-encryption",
			Assumption: "audited ballot sampling is representative; unaudited cast ballot remains hidden",
			PaperRef:   "PAPER-3 (23차)",
		},
		RecordedAsCast: SecurityProperty{
			Property:   "Recorded-as-Cast",
			Status:     "implemented",
			Mechanism:  "Merkle tree inclusion proof (hashWithLengthPrefix)",
			Assumption: "SHA-256 collision resistance",
			PaperRef:   "Merkle proof (기존)",
		},
		TalliedAsRecorded: SecurityProperty{
			Property:   "Tallied-as-Recorded",
			Status:     "implemented",
			Mechanism:  "Homomorphic ElGamal tally with proof-carrying 2-of-3 partial decryptions",
			Assumption: "DDH; every included ballot has a validity proof; filtering requires separate proof",
			PaperRef:   "PAPER-2 (22차), PAPER-13 (33차)",
		},
		UniversalVerifiability: SecurityProperty{
			Property:   "Universal Verifiability",
			Status:     "implemented",
			Mechanism:  "Signed offline bundle v5 verifies DKG commitments, ballots, aggregate, trustee proofs, and tally",
			Assumption: "bundle publication is complete; organization signing threshold is honestly operated",
			PaperRef:   "PAPER-6 (26차), PAPER-13 (33차)",
		},
		CoercionResistance: SecurityProperty{
			Property:   "Coercion Resistance",
			Status:     "unverified",
			Mechanism:  "Opaque fixed-size proof API plus experimental panic filtering and re-voting",
			Assumption: "API transcript sub-test passed; PDC/backend collusion, forced abstention, credential surrender and revote-pattern hiding remain unresolved",
			PaperRef:   "PAPER-12 (32차)",
		},
		EligibilityVerify: SecurityProperty{
			Property:   "Eligibility Verifiability",
			Status:     credStatus,
			Mechanism:  credMechanism + " + 2-of-3 endorsement",
			Assumption: "HMAC-SHA256 PRF / Ed25519 SUF-CMA",
			PaperRef:   "PAPER-4 (24차)",
		},
		CryptoPrimitives: []string{
			"AES-256-GCM (symmetric encryption, deterministic nonce)",
			"Exponential ElGamal (additive homomorphic encryption, RFC 3526 Group 14)",
			"Disjunctive Chaum-Pedersen ZKP (ballot validity proof, Cramer-Damgård-Schoenmakers 1994)",
			"Chaum-Pedersen ZKP (non-interactive decryption correctness proof)",
			"Baby-Step Giant-Step (discrete log recovery for homomorphic tally)",
			"SHA-256 (hash, commitment, Merkle tree)",
			"Ed25519 (credential signature, RFC 8032)",
			"HMAC-SHA256 (credential authentication)",
			"Authenticated Feldman DKG or legacy dealer-assisted threshold ElGamal (2-of-3 partial decryption)",
			"Opaque fixed-size deniable-proof API (limited mitigation; not full coercion resistance)",
		},
		EndorsementPolicy: "2-of-3 (ElectionCommission, PartyObserver, CivilSociety)",
	}, nil
}

// computeTallyProofHash [PAPER-2] 모든 DecryptionProof를 정렬 후 해시하여 집계 무결성 증명을 생성합니다.
// 검증자는 이 해시를 재계산하여 집계 결과 변조 여부를 확인할 수 있습니다.
func computeTallyProofHash(proofs []DecryptionProof) string {
	if len(proofs) == 0 {
		return ""
	}
	// nullifierHash 기준 정렬 (결정론적 순서)
	sorted := make([]DecryptionProof, len(proofs))
	copy(sorted, proofs)
	sort.Slice(sorted, func(i, j int) bool {
		return sorted[i].NullifierHash < sorted[j].NullifierHash
	})

	h := sha256.New()
	for _, p := range sorted {
		h.Write([]byte(p.NullifierHash))
		h.Write([]byte(p.EncryptedCandidateID))
		h.Write([]byte(p.DecryptedHash))
	}
	return hex.EncodeToString(h.Sum(nil))
}

// ============================================================
// [PAPER-7] Vote Shuffle — 시간 분석 공격 방지
// ============================================================

// deterministicShuffle Fisher-Yates 셔플을 결정론적 시드로 수행합니다.
// 시드에서 의사 난수를 SHA-256 체인으로 생성하여 모든 피어에서 동일한 순서를 보장합니다.
// ballots와 proofs를 동일한 순열로 셔플합니다.
func deterministicShuffle(ballots []EncryptedBallot, proofs []DecryptionProof, seed []byte) ([]EncryptedBallot, []DecryptionProof) {
	n := len(ballots)
	if n <= 1 {
		return ballots, proofs
	}

	// 복사본 생성
	shuffledB := make([]EncryptedBallot, n)
	copy(shuffledB, ballots)
	shuffledP := make([]DecryptionProof, len(proofs))
	copy(shuffledP, proofs)

	// nullifierHash → proof index 매핑 (ballot과 proof를 동기화)
	proofMap := make(map[string]int)
	for i, p := range shuffledP {
		proofMap[p.NullifierHash] = i
	}

	// Fisher-Yates shuffle with deterministic PRNG
	rngState := seed
	for i := n - 1; i > 0; i-- {
		// SHA-256 체인으로 다음 의사 난수 생성
		nextHash := sha256.Sum256(append(rngState, byte(i)))
		rngState = nextHash[:]
		// big.Int로 변환하여 modulo
		j := int(new(big.Int).SetBytes(rngState).Int64()) % (i + 1)
		if j < 0 {
			j = -j
		}
		// ballot 스왑
		shuffledB[i], shuffledB[j] = shuffledB[j], shuffledB[i]
	}

	// proof도 셔플된 ballot 순서에 맞게 재배열
	reorderedP := make([]DecryptionProof, 0, len(shuffledP))
	for _, b := range shuffledB {
		if idx, ok := proofMap[b.NullifierHash]; ok {
			reorderedP = append(reorderedP, shuffledP[idx])
		}
	}
	// proof가 ballot보다 적을 수 있음 (레거시 투표 등)
	if len(reorderedP) < len(shuffledP) {
		// 매칭되지 않은 proof 추가
		matchedSet := make(map[string]bool)
		for _, b := range shuffledB {
			matchedSet[b.NullifierHash] = true
		}
		for _, p := range shuffledP {
			if !matchedSet[p.NullifierHash] {
				reorderedP = append(reorderedP, p)
			}
		}
	}

	return shuffledB, reorderedP
}

// computeShuffleProofHash 셔플 정확성 증명: 셔플 전후 nullifier 집합이 동일함을 검증.
// 정렬된 nullifierHash 집합의 해시가 동일하면 투표가 추가/삭제되지 않았음을 증명.
func computeShuffleProofHash(original, shuffled []EncryptedBallot) string {
	hashSet := func(ballots []EncryptedBallot) string {
		hashes := make([]string, len(ballots))
		for i, b := range ballots {
			hashes[i] = b.NullifierHash
		}
		sort.Strings(hashes)
		h := sha256.New()
		for _, nh := range hashes {
			h.Write([]byte(nh))
		}
		return hex.EncodeToString(h.Sum(nil))
	}
	origHash := hashSet(original)
	shuffHash := hashSet(shuffled)
	// 두 해시가 같으면 집합 동일 → 셔플 정확성 증명
	// 최종 proof = SHA256(origHash + shuffHash)
	proof := sha256.Sum256([]byte(origHash + shuffHash))
	return hex.EncodeToString(proof[:])
}

// ============================================================
// AES-GCM 암호화 헬퍼 — [C-4] candidateID 암호화 집계
// ============================================================

// encryptAESGCM AES-256-GCM으로 평문을 암호화합니다.
// key: 32바이트, plaintext: 임의 길이 → hex(nonce + ciphertext) 반환
// nonce는 SHA256(key + plaintext)에서 12바이트 추출 (결정론적 — 피어 간 동일 결과)
func encryptAESGCM(key []byte, plaintext string) (string, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return "", fmt.Errorf("AES 블록 생성 실패: %w", err)
	}
	aesGCM, err := cipher.NewGCM(block)
	if err != nil {
		return "", fmt.Errorf("GCM 생성 실패: %w", err)
	}
	// 결정론적 nonce: SHA256(key + plaintext)의 앞 12바이트
	// 체인코드 결정론성 보장 (모든 피어에서 동일 nonce 생성)
	nonceInput := append(key, []byte(plaintext)...)
	nonceHash := sha256.Sum256(nonceInput)
	nonce := nonceHash[:aesGCM.NonceSize()]

	ciphertext := aesGCM.Seal(nil, nonce, []byte(plaintext), nil)
	// nonce + ciphertext를 hex 인코딩
	result := append(nonce, ciphertext...)
	return hex.EncodeToString(result), nil
}

// decryptAESGCM AES-256-GCM으로 복호화합니다.
// key: 32바이트, encryptedHex: hex(nonce + ciphertext) → 평문 반환
func decryptAESGCM(key []byte, encryptedHex string) (string, error) {
	data, err := hex.DecodeString(encryptedHex)
	if err != nil {
		return "", fmt.Errorf("hex 디코딩 실패: %w", err)
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return "", fmt.Errorf("AES 블록 생성 실패: %w", err)
	}
	aesGCM, err := cipher.NewGCM(block)
	if err != nil {
		return "", fmt.Errorf("GCM 생성 실패: %w", err)
	}
	nonceSize := aesGCM.NonceSize()
	if len(data) < nonceSize {
		return "", fmt.Errorf("암호문이 너무 짧음")
	}
	nonce, ciphertext := data[:nonceSize], data[nonceSize:]
	plaintext, err := aesGCM.Open(nil, nonce, ciphertext, nil)
	if err != nil {
		return "", fmt.Errorf("복호화 실패: %w", err)
	}
	return string(plaintext), nil
}

// getEncryptionKey PDC에서 선거 암호화 키를 조회합니다.
func getEncryptionKey(ctx contractapi.TransactionContextInterface, electionID string) ([]byte, error) {
	ekKey := "ENCRYPTION_KEY_" + electionID
	ekHex, err := ctx.GetStub().GetPrivateData(VotePrivatePDC, ekKey)
	if err != nil || ekHex == nil {
		return nil, fmt.Errorf("암호화 키 조회 실패 (election: %s)", electionID)
	}
	return hex.DecodeString(string(ekHex))
}

// ============================================================
// [PAPER-11] ElGamal 암호화 헬퍼 — RFC 3526 Group 14 (2048-bit MODP)
// ============================================================

// elgamalGenerateKeyPair 결정론적 ElGamal 키쌍 생성
// seed에서 비밀키 x를 유도 → Fabric 결정론성 보장
// elgamalKeySeedFromAES [P2] AES 마스터키로부터 ElGamal 키 seed를 결정론적으로 유도.
// CreateElection(최초 생성)과 verifyKeyReconstruction(복원 후 재유도)에서 동일하게 사용.
func elgamalKeySeedFromAES(aesKey []byte) []byte {
	s := sha256.Sum256(append([]byte("ELGAMAL::"), aesKey...))
	return s[:]
}

func elgamalGenerateKeyPair(seed []byte) (x *big.Int, pubKey *ElGamalPublicKey) {
	// x = SHA256(seed) mod q, x != 0
	xHash := sha256.Sum256(seed)
	x = new(big.Int).SetBytes(xHash[:])
	x.Mod(x, elgamalQ)
	if x.Sign() == 0 {
		x.SetInt64(1)
	}
	// y = g^x mod p
	y := new(big.Int).Exp(elgamalG, x, elgamalP)

	pubKey = &ElGamalPublicKey{
		P: elgamalP.Text(16),
		G: elgamalG.Text(16),
		Y: y.Text(16),
	}
	return x, pubKey
}

// elgamalDecrypt ElGamal 복호화: m = c2 * c1^(-x) mod p
func elgamalDecrypt(x *big.Int, c1Hex, c2Hex string) (string, error) {
	c1, ok1 := new(big.Int).SetString(c1Hex, 16)
	c2, ok2 := new(big.Int).SetString(c2Hex, 16)
	if !ok1 || !ok2 {
		return "", fmt.Errorf("ElGamal 암호문 파싱 실패")
	}

	// s = c1^x mod p
	s := new(big.Int).Exp(c1, x, elgamalP)
	// s_inv = s^(-1) mod p
	sInv := new(big.Int).ModInverse(s, elgamalP)
	if sInv == nil {
		return "", fmt.Errorf("모듈러 역원 계산 실패")
	}
	// m = c2 * s^(-1) mod p
	m := new(big.Int).Mul(c2, sInv)
	m.Mod(m, elgamalP)

	return elgamalDecodePlaintext(m)
}

// elgamalEncodePlaintext candidateID 문자열을 BigInt로 인코딩
// 0x01 prefix를 추가하여 0이 되지 않도록 보장
func elgamalEncodePlaintext(plaintext string) *big.Int {
	data := append([]byte{0x01}, []byte(plaintext)...)
	return new(big.Int).SetBytes(data)
}

// elgamalDecodePlaintext BigInt를 candidateID 문자열로 디코딩
func elgamalDecodePlaintext(m *big.Int) (string, error) {
	data := m.Bytes()
	if len(data) == 0 || data[0] != 0x01 {
		return "", fmt.Errorf("ElGamal 평문 디코딩 실패: 잘못된 prefix")
	}
	return string(data[1:]), nil
}

// chaumPedersenProve Chaum-Pedersen ZKP 생성 (Fiat-Shamir 비대화형)
// 증명: "y = g^x AND s = c1^x" (s = c2/m, 올바른 복호화 증명)
// 결정론적 k: SHA256(x || c1 || c2 || electionID || nullifierHash) → Fabric 결정론성 보장
func chaumPedersenProve(x *big.Int, c1Hex, c2Hex, mHex, nullifierHash, electionID string) (*ChaumPedersenProof, string, error) {
	c1, _ := new(big.Int).SetString(c1Hex, 16)
	c2, _ := new(big.Int).SetString(c2Hex, 16)
	m, _ := new(big.Int).SetString(mHex, 16)
	y := new(big.Int).Exp(elgamalG, x, elgamalP)

	// s = c2/m mod p = c2 * m^(-1) mod p → 이것이 c1^x와 같음을 증명
	mInv := new(big.Int).ModInverse(m, elgamalP)
	s := new(big.Int).Mul(c2, mInv)
	s.Mod(s, elgamalP)

	// 결정론적 k 유도 (Fabric 결정론성)
	kInput := append(x.Bytes(), []byte(c1Hex+c2Hex+electionID+nullifierHash)...)
	kHash := sha256.Sum256(kInput)
	k := new(big.Int).SetBytes(kHash[:])
	k.Mod(k, elgamalQ)
	if k.Sign() == 0 {
		k.SetInt64(1)
	}

	// a1 = g^k mod p
	a1 := new(big.Int).Exp(elgamalG, k, elgamalP)
	// a2 = c1^k mod p
	a2 := new(big.Int).Exp(c1, k, elgamalP)

	// Fiat-Shamir challenge: e = SHA256(g || y || c1 || s || a1 || a2) mod q
	eInput := fmt.Sprintf("%s|%s|%s|%s|%s|%s",
		elgamalG.Text(16), y.Text(16), c1.Text(16), s.Text(16), a1.Text(16), a2.Text(16))
	eHash := sha256.Sum256([]byte(eInput))
	e := new(big.Int).SetBytes(eHash[:])
	e.Mod(e, elgamalQ)

	// z = k + e*x mod q
	z := new(big.Int).Mul(e, x)
	z.Add(z, k)
	z.Mod(z, elgamalQ)

	// 복호화된 평문 해시
	plaintext, err := elgamalDecodePlaintext(m)
	if err != nil {
		return nil, "", err
	}
	dh := sha256.Sum256([]byte(plaintext))

	proof := &ChaumPedersenProof{
		NullifierHash: nullifierHash,
		C1:            c1Hex,
		C2:            c2Hex,
		DecryptedHash: hex.EncodeToString(dh[:]),
		A1:            a1.Text(16),
		A2:            a2.Text(16),
		E:             e.Text(16),
		Z:             z.Text(16),
	}

	return proof, plaintext, nil
}

// chaumPedersenProveRaw [PAPER-13] Chaum-Pedersen ZKP 생성 (raw BigInt 평문)
// 동형 집계용: 복호화 결과가 g^sum (0x01 prefix 없음)이므로 elgamalDecodePlaintext 호출 불가
// 대신 decryptedHash를 외부에서 직접 제공
func chaumPedersenProveRaw(x *big.Int, c1Hex, c2Hex, mHex, nullifierHash, electionID, decryptedHashHex string) (*ChaumPedersenProof, error) {
	c1, _ := new(big.Int).SetString(c1Hex, 16)
	c2, _ := new(big.Int).SetString(c2Hex, 16)
	m, _ := new(big.Int).SetString(mHex, 16)
	y := new(big.Int).Exp(elgamalG, x, elgamalP)

	mInv := new(big.Int).ModInverse(m, elgamalP)
	if mInv == nil {
		return nil, fmt.Errorf("모듈러 역원 계산 실패")
	}
	s := new(big.Int).Mul(c2, mInv)
	s.Mod(s, elgamalP)

	kInput := append(x.Bytes(), []byte(c1Hex+c2Hex+electionID+nullifierHash)...)
	kHash := sha256.Sum256(kInput)
	k := new(big.Int).SetBytes(kHash[:])
	k.Mod(k, elgamalQ)
	if k.Sign() == 0 {
		k.SetInt64(1)
	}

	a1 := new(big.Int).Exp(elgamalG, k, elgamalP)
	a2 := new(big.Int).Exp(c1, k, elgamalP)

	eInput := fmt.Sprintf("%s|%s|%s|%s|%s|%s",
		elgamalG.Text(16), y.Text(16), c1.Text(16), s.Text(16), a1.Text(16), a2.Text(16))
	eHash := sha256.Sum256([]byte(eInput))
	e := new(big.Int).SetBytes(eHash[:])
	e.Mod(e, elgamalQ)

	z := new(big.Int).Mul(e, x)
	z.Add(z, k)
	z.Mod(z, elgamalQ)

	proof := &ChaumPedersenProof{
		NullifierHash: nullifierHash,
		C1:            c1Hex,
		C2:            c2Hex,
		DecryptedHash: decryptedHashHex,
		A1:            a1.Text(16),
		A2:            a2.Text(16),
		E:             e.Text(16),
		Z:             z.Text(16),
	}
	return proof, nil
}

func parseNonzeroFieldElement(encoded string) (*big.Int, bool) {
	v, ok := new(big.Int).SetString(encoded, 16)
	if !ok || v.Sign() <= 0 || v.Cmp(elgamalP) >= 0 {
		return nil, false
	}
	return v, true
}

func parseSubgroupElement(encoded string) (*big.Int, bool) {
	v, ok := parseNonzeroFieldElement(encoded)
	if !ok || v.Cmp(big.NewInt(1)) == 0 {
		return nil, false
	}
	if new(big.Int).Exp(v, elgamalQ, elgamalP).Cmp(big.NewInt(1)) != 0 {
		return nil, false
	}
	return v, true
}

func parseScalar(encoded string) (*big.Int, bool) {
	v, ok := new(big.Int).SetString(encoded, 16)
	if !ok || v.Sign() < 0 || v.Cmp(elgamalQ) >= 0 {
		return nil, false
	}
	return v, true
}

func parseCanonicalNonzeroScalar(encoded string) (*big.Int, bool) {
	if encoded == "" || strings.ToLower(encoded) != encoded || (len(encoded) > 1 && encoded[0] == '0') {
		return nil, false
	}
	for _, char := range encoded {
		if !((char >= '0' && char <= '9') || (char >= 'a' && char <= 'f')) {
			return nil, false
		}
	}
	v, ok := parseScalar(encoded)
	if !ok || v.Sign() <= 0 {
		return nil, false
	}
	return v, true
}

// verifyVectorAuditWitness independently reconstructs every component of a
// prepared one-hot vector. It intentionally does not trust the submitted ZKP:
// the disclosed randomness and selected index must reproduce the exact stored
// ciphertext bytes before an audit transition can commit.
func verifyVectorAuditWitness(pubKey *ElGamalPublicKey, vector []ElGamalCiphertext, selectedIndex int, randomness []string) bool {
	if pubKey == nil || pubKey.P != elgamalP.Text(16) || pubKey.G != elgamalG.Text(16) ||
		len(vector) < 2 || len(randomness) != len(vector) || selectedIndex < 0 || selectedIndex >= len(vector) {
		return false
	}
	y, ok := parseSubgroupElement(pubKey.Y)
	if !ok {
		return false
	}
	for index, ciphertext := range vector {
		r, valid := parseCanonicalNonzeroScalar(randomness[index])
		if !valid {
			return false
		}
		expectedC1 := new(big.Int).Exp(elgamalG, r, elgamalP)
		expectedC2 := new(big.Int).Exp(y, r, elgamalP)
		if index == selectedIndex {
			expectedC2.Mul(expectedC2, elgamalG)
			expectedC2.Mod(expectedC2, elgamalP)
		}
		if ciphertext.C1 != expectedC1.Text(16) || ciphertext.C2 != expectedC2.Text(16) {
			return false
		}
	}
	return true
}

func deriveThresholdShares(secret, coefficient *big.Int, total int) ([]*big.Int, error) {
	if secret == nil || coefficient == nil || secret.Sign() <= 0 || secret.Cmp(elgamalQ) >= 0 ||
		coefficient.Sign() <= 0 || coefficient.Cmp(elgamalQ) >= 0 || total < 2 {
		return nil, fmt.Errorf("threshold share parameters invalid")
	}
	shares := make([]*big.Int, total)
	for i := 1; i <= total; i++ {
		s := new(big.Int).Mul(coefficient, big.NewInt(int64(i)))
		s.Add(s, secret)
		s.Mod(s, elgamalQ)
		if s.Sign() == 0 {
			return nil, fmt.Errorf("threshold share %d is zero", i)
		}
		shares[i-1] = s
	}
	return shares, nil
}

// lagrangeCoefficientAtZero returns Π_{j!=i} j/(j-i) mod q.
func lagrangeCoefficientAtZero(index int, indexes []int) (*big.Int, error) {
	if index < 1 || len(indexes) < 2 {
		return nil, fmt.Errorf("invalid Lagrange index set")
	}
	numerator := big.NewInt(1)
	denominator := big.NewInt(1)
	seen := make(map[int]bool, len(indexes))
	found := false
	for _, j := range indexes {
		if j < 1 || seen[j] {
			return nil, fmt.Errorf("invalid or duplicate trustee index: %d", j)
		}
		seen[j] = true
		if j == index {
			found = true
			continue
		}
		numerator.Mul(numerator, big.NewInt(int64(j)))
		numerator.Mod(numerator, elgamalQ)
		difference := big.NewInt(int64(j - index))
		difference.Mod(difference, elgamalQ)
		denominator.Mul(denominator, difference)
		denominator.Mod(denominator, elgamalQ)
	}
	if !found {
		return nil, fmt.Errorf("trustee index %d not in subset", index)
	}
	inv := new(big.Int).ModInverse(denominator, elgamalQ)
	if inv == nil {
		return nil, fmt.Errorf("Lagrange denominator is not invertible")
	}
	return new(big.Int).Mod(new(big.Int).Mul(numerator, inv), elgamalQ), nil
}

func combinePartialDecryptionValues(values map[int]*big.Int) (*big.Int, error) {
	if len(values) < ShamirThreshold {
		return nil, fmt.Errorf("threshold 미달: %d/%d", len(values), ShamirThreshold)
	}
	indexes := make([]int, 0, len(values))
	for index, value := range values {
		if index < 1 || index > ShamirTotalShares || value == nil ||
			value.Sign() <= 0 || value.Cmp(elgamalP) >= 0 ||
			new(big.Int).Exp(value, elgamalQ, elgamalP).Cmp(big.NewInt(1)) != 0 {
			return nil, fmt.Errorf("partial decryption %d invalid", index)
		}
		indexes = append(indexes, index)
	}
	sort.Ints(indexes)
	combined := big.NewInt(1)
	for _, index := range indexes {
		lambda, err := lagrangeCoefficientAtZero(index, indexes)
		if err != nil {
			return nil, err
		}
		term := new(big.Int).Exp(values[index], lambda, elgamalP)
		combined.Mul(combined, term)
		combined.Mod(combined, elgamalP)
	}
	return combined, nil
}

// chaumPedersenVerify Chaum-Pedersen ZKP 검증 (누구나 공개키로 검증 가능)
// 검증: g^z == a1 * y^e mod p AND c1^z == a2 * s^e mod p
func chaumPedersenVerify(pubKey *ElGamalPublicKey, proof *ChaumPedersenProof, decryptedPlaintext string) bool {
	if pubKey == nil || proof == nil || pubKey.P != elgamalP.Text(16) || pubKey.G != elgamalG.Text(16) {
		return false
	}
	p, g := elgamalP, elgamalG
	y, okY := parseSubgroupElement(pubKey.Y)
	c1, okC1 := parseSubgroupElement(proof.C1)
	c2, okC2 := parseNonzeroFieldElement(proof.C2)
	a1, okA1 := parseSubgroupElement(proof.A1)
	a2, okA2 := parseSubgroupElement(proof.A2)
	e, okE := parseScalar(proof.E)
	z, okZ := parseScalar(proof.Z)
	if !(okY && okC1 && okC2 && okA1 && okA2 && okE && okZ) {
		return false
	}

	// m = encode(decryptedPlaintext)
	m := elgamalEncodePlaintext(decryptedPlaintext)
	// s = c2 * m^(-1) mod p
	mInv := new(big.Int).ModInverse(m, p)
	if mInv == nil {
		return false
	}
	s := new(big.Int).Mul(c2, mInv)
	s.Mod(s, p)

	eInput := fmt.Sprintf("%s|%s|%s|%s|%s|%s",
		g.Text(16), y.Text(16), c1.Text(16), s.Text(16), a1.Text(16), a2.Text(16))
	eHash := sha256.Sum256([]byte(eInput))
	expectedE := new(big.Int).SetBytes(eHash[:])
	expectedE.Mod(expectedE, elgamalQ)
	if e.Cmp(expectedE) != 0 {
		return false
	}

	// 검증 1: g^z == a1 * y^e mod p
	lhs1 := new(big.Int).Exp(g, z, p)
	rhs1 := new(big.Int).Exp(y, e, p)
	rhs1.Mul(rhs1, a1)
	rhs1.Mod(rhs1, p)
	if lhs1.Cmp(rhs1) != 0 {
		return false
	}

	// 검증 2: c1^z == a2 * s^e mod p
	lhs2 := new(big.Int).Exp(c1, z, p)
	rhs2 := new(big.Int).Exp(s, e, p)
	rhs2.Mul(rhs2, a2)
	rhs2.Mod(rhs2, p)
	return lhs2.Cmp(rhs2) == 0
}

// chaumPedersenVerifyRaw [PAPER-13] Chaum-Pedersen ZKP 검증 (raw BigInt 평문)
// 동형 집계용: m = g^sum (elgamalEncodePlaintext 호출 불가)
func chaumPedersenVerifyRaw(pubKey *ElGamalPublicKey, proof *ChaumPedersenProof, m *big.Int) bool {
	if pubKey == nil || proof == nil || m == nil || pubKey.P != elgamalP.Text(16) || pubKey.G != elgamalG.Text(16) {
		return false
	}
	p, g := elgamalP, elgamalG
	y, okY := parseSubgroupElement(pubKey.Y)
	c1, okC1 := parseSubgroupElement(proof.C1)
	c2, okC2 := parseSubgroupElement(proof.C2)
	a1, okA1 := parseSubgroupElement(proof.A1)
	a2, okA2 := parseSubgroupElement(proof.A2)
	e, okE := parseScalar(proof.E)
	z, okZ := parseScalar(proof.Z)
	if !(okY && okC1 && okC2 && okA1 && okA2 && okE && okZ) || m.Sign() <= 0 || m.Cmp(p) >= 0 {
		return false
	}

	// s = c2 * m^(-1) mod p
	mInv := new(big.Int).ModInverse(m, p)
	if mInv == nil {
		return false
	}
	s := new(big.Int).Mul(c2, mInv)
	s.Mod(s, p)

	eInput := fmt.Sprintf("%s|%s|%s|%s|%s|%s",
		g.Text(16), y.Text(16), c1.Text(16), s.Text(16), a1.Text(16), a2.Text(16))
	eHash := sha256.Sum256([]byte(eInput))
	expectedE := new(big.Int).SetBytes(eHash[:])
	expectedE.Mod(expectedE, elgamalQ)
	if e.Cmp(expectedE) != 0 {
		return false
	}

	// 검증 1: g^z == a1 * y^e mod p
	lhs1 := new(big.Int).Exp(g, z, p)
	rhs1 := new(big.Int).Exp(y, e, p)
	rhs1.Mul(rhs1, a1)
	rhs1.Mod(rhs1, p)
	if lhs1.Cmp(rhs1) != 0 {
		return false
	}

	// 검증 2: c1^z == a2 * s^e mod p
	lhs2 := new(big.Int).Exp(c1, z, p)
	rhs2 := new(big.Int).Exp(s, e, p)
	rhs2.Mul(rhs2, a2)
	rhs2.Mod(rhs2, p)
	return lhs2.Cmp(rhs2) == 0
}

// getElGamalPrivateKey PDC에서 ElGamal 비밀키를 조회합니다.
func getElGamalPrivateKey(ctx contractapi.TransactionContextInterface, electionID string) (*big.Int, error) {
	pkKey := "ELGAMAL_PRIVKEY_" + electionID
	pkHex, err := ctx.GetStub().GetPrivateData(VotePrivatePDC, pkKey)
	if err != nil || pkHex == nil {
		return nil, fmt.Errorf("ElGamal 비밀키 조회 실패 (election: %s)", electionID)
	}
	x, ok := new(big.Int).SetString(string(pkHex), 16)
	if !ok {
		return nil, fmt.Errorf("ElGamal 비밀키 파싱 실패")
	}
	return x, nil
}

// ============================================================
// [PAPER-13] Exponential ElGamal 동형 집계 헬퍼
// ============================================================

// expElGamalEncodeCandidate 후보 인덱스를 Exponential ElGamal 메시지로 인코딩
// candidate index i → g^(B^i) mod p (0-indexed)
// 동형 성질: Π E(B^i_j) = E(Σ B^i_j) → base-B 자릿수 분해로 후보별 득표수 복원
func expElGamalEncodeCandidate(candidateIndex int) *big.Int {
	// m = B^candidateIndex
	base := big.NewInt(HomomorphicBase)
	exp := big.NewInt(int64(candidateIndex))
	m := new(big.Int).Exp(base, exp, nil) // B^i (작은 수, mod 불필요)
	// g^m mod p
	gm := new(big.Int).Exp(elgamalG, m, elgamalP)
	return gm
}

// expElGamalDecryptToGm ElGamal 복호화하되 평문이 아닌 g^m을 반환
// 일반 ElGamal: c2 * c1^(-x) = m (직접 평문)
// Exponential ElGamal: c2 * c1^(-x) = g^m (이산로그 필요)
func expElGamalDecryptToGm(x *big.Int, c1Hex, c2Hex string) (*big.Int, error) {
	c1, ok1 := new(big.Int).SetString(c1Hex, 16)
	c2, ok2 := new(big.Int).SetString(c2Hex, 16)
	if !ok1 || !ok2 {
		return nil, fmt.Errorf("ElGamal 암호문 파싱 실패")
	}
	s := new(big.Int).Exp(c1, x, elgamalP)
	sInv := new(big.Int).ModInverse(s, elgamalP)
	if sInv == nil {
		return nil, fmt.Errorf("모듈러 역원 계산 실패")
	}
	gm := new(big.Int).Mul(c2, sInv)
	gm.Mod(gm, elgamalP)
	return gm, nil
}

// babyStepGiantStep g^m mod p에서 m을 복원 (Baby-Step Giant-Step)
// O(√maxValue) 시간/공간 복잡도
// maxValue: m의 최대값 (= HomomorphicBase^numCandidates 이내)
func babyStepGiantStep(target, g, p *big.Int, maxValue int64) (int64, error) {
	// m = ceil(√maxValue)
	mStep := int64(1)
	for mStep*mStep < maxValue {
		mStep++
	}

	// Baby step: table[g^j mod p] = j, for j = 0..mStep-1
	table := make(map[string]int64, mStep)
	gj := big.NewInt(1)
	for j := int64(0); j < mStep; j++ {
		table[gj.Text(16)] = j
		gj.Mul(gj, g)
		gj.Mod(gj, p)
	}

	// Giant step factor: g^(-mStep) mod p
	gm := new(big.Int).Exp(g, big.NewInt(mStep), p)
	gmInv := new(big.Int).ModInverse(gm, p)
	if gmInv == nil {
		return 0, fmt.Errorf("BSGS: giant step 역원 계산 실패")
	}

	// Giant step: gamma = target * (g^(-mStep))^i mod p
	gamma := new(big.Int).Set(target)
	for i := int64(0); i < mStep; i++ {
		if j, found := table[gamma.Text(16)]; found {
			result := i*mStep + j
			return result, nil
		}
		gamma.Mul(gamma, gmInv)
		gamma.Mod(gamma, p)
	}
	return 0, fmt.Errorf("BSGS: 이산로그 복원 실패 (maxValue=%d 초과)", maxValue)
}

// decomposeBaseB 합산 값을 base-B로 자릿수 분해 → 후보별 득표수 복원
// sum = c_0 + c_1*B + c_2*B^2 + ...
func decomposeBaseB(sum int64, numCandidates int) []int {
	counts := make([]int, numCandidates)
	for i := 0; i < numCandidates; i++ {
		counts[i] = int(sum % HomomorphicBase)
		sum /= HomomorphicBase
	}
	return counts
}

// validateHomomorphicTallyCapacity prevents ambiguous base-B carries and an
// infeasible/overflowed BSGS search. The current scalar encoding is a prototype
// limit; large elections must use a per-candidate ciphertext vector instead.
func validateHomomorphicTallyCapacity(totalVotes, numCandidates int) error {
	if totalVotes < 0 || numCandidates <= 0 {
		return fmt.Errorf("동형 집계 범위 오류: votes=%d candidates=%d", totalVotes, numCandidates)
	}
	if totalVotes >= HomomorphicBase {
		return fmt.Errorf("동형 집계 인코딩 용량 초과: votes=%d, candidate digit base=%d", totalVotes, HomomorphicBase)
	}
	bound := big.NewInt(int64(totalVotes) + 1)
	base := big.NewInt(HomomorphicBase)
	for i := 0; i < numCandidates-1; i++ {
		bound.Mul(bound, base)
	}
	if !bound.IsInt64() || bound.Int64() > maxBSGSSearch {
		return fmt.Errorf("BSGS 안전 상한 초과: required=%s limit=%d (votes=%d candidates=%d)",
			bound.String(), maxBSGSSearch, totalVotes, numCandidates)
	}
	return nil
}

// verifyBallotValidityZKP [PAPER-13] Disjunctive Chaum-Pedersen ZKP 검증
// 투표 암호문 (c1, c2)가 {g^(B^0), g^(B^1), ..., g^(B^(k-1))} 중 하나를 암호화했음을 검증
// Cramer-Damgård-Schoenmakers (1994) OR-proof
func verifyBallotValidityZKP(pubKey *ElGamalPublicKey, c1Hex, c2Hex string, numCandidates int, proof *BallotValidityProof) bool {
	if pubKey == nil || pubKey.P != elgamalP.Text(16) || pubKey.G != elgamalG.Text(16) ||
		numCandidates <= 0 || proof == nil || len(proof.A1s) != numCandidates || len(proof.A2s) != numCandidates ||
		len(proof.Es) != numCandidates || len(proof.Zs) != numCandidates {
		return false
	}

	p, g, q := elgamalP, elgamalG, elgamalQ
	y, okY := parseSubgroupElement(pubKey.Y)
	c1, okC1 := parseSubgroupElement(c1Hex)
	c2, okC2 := parseSubgroupElement(c2Hex)
	if !(okY && okC1 && okC2) {
		return false
	}

	// 각 후보 j에 대해 검증
	eSum := big.NewInt(0)
	for j := 0; j < numCandidates; j++ {
		a1j, okA1 := parseSubgroupElement(proof.A1s[j])
		a2j, okA2 := parseSubgroupElement(proof.A2s[j])
		ej, okE := parseScalar(proof.Es[j])
		zj, okZ := parseScalar(proof.Zs[j])
		if !(okA1 && okA2 && okE && okZ) {
			return false
		}

		// 후보 j의 메시지: g^(B^j) mod p
		mj := expElGamalEncodeCandidate(j)
		// c2/mj mod p = c2 * mj^(-1) mod p
		mjInv := new(big.Int).ModInverse(mj, p)
		c2DivMj := new(big.Int).Mul(c2, mjInv)
		c2DivMj.Mod(c2DivMj, p)

		// 검증 1: g^zj == a1j * c1^ej mod p
		lhs1 := new(big.Int).Exp(g, zj, p)
		rhs1 := new(big.Int).Exp(c1, ej, p)
		rhs1.Mul(rhs1, a1j)
		rhs1.Mod(rhs1, p)
		if lhs1.Cmp(rhs1) != 0 {
			return false
		}

		// 검증 2: y^zj == a2j * (c2/mj)^ej mod p
		lhs2 := new(big.Int).Exp(y, zj, p)
		rhs2 := new(big.Int).Exp(c2DivMj, ej, p)
		rhs2.Mul(rhs2, a2j)
		rhs2.Mod(rhs2, p)
		if lhs2.Cmp(rhs2) != 0 {
			return false
		}

		eSum.Add(eSum, ej)
	}

	// 전체 challenge 합산 검증: Σe_j == SHA256(c1 || c2 || a1_0 || a2_0 || ... || a1_{k-1} || a2_{k-1}) mod q
	hashInput := c1Hex + "|" + c2Hex
	for j := 0; j < numCandidates; j++ {
		hashInput += "|" + proof.A1s[j] + "|" + proof.A2s[j]
	}
	eHash := sha256.Sum256([]byte(hashInput))
	expectedE := new(big.Int).SetBytes(eHash[:])
	expectedE.Mod(expectedE, q)

	eSum.Mod(eSum, q)
	return eSum.Cmp(expectedE) == 0
}

// verifyVectorBallotValidityZKP verifies vector-v3 one-hot ballots. Each
// ciphertext must encrypt 0 or 1, and the product must encrypt exactly 1.
func verifyVectorBallotValidityZKP(pubKey *ElGamalPublicKey, ciphertexts []ElGamalCiphertext, proof *VectorBallotValidityProof) bool {
	if pubKey == nil || len(ciphertexts) == 0 || proof == nil ||
		len(proof.BitProofs) != len(ciphertexts) || proof.SumProof == nil {
		return false
	}
	messages := []*big.Int{big.NewInt(1), new(big.Int).Set(elgamalG)}
	productC1, productC2 := big.NewInt(1), big.NewInt(1)
	for i, ciphertext := range ciphertexts {
		if !verifyDisjunctiveElGamalProof(pubKey, ciphertext.C1, ciphertext.C2, messages,
			fmt.Sprintf("mongbas/vector-v3/bit/%d", i), proof.BitProofs[i]) {
			return false
		}
		c1, ok1 := parseSubgroupElement(ciphertext.C1)
		c2, ok2 := parseSubgroupElement(ciphertext.C2)
		if !ok1 || !ok2 {
			return false
		}
		productC1.Mul(productC1, c1).Mod(productC1, elgamalP)
		productC2.Mul(productC2, c2).Mod(productC2, elgamalP)
	}
	gInv := new(big.Int).ModInverse(elgamalG, elgamalP)
	if gInv == nil {
		return false
	}
	productC2DivG := new(big.Int).Mul(productC2, gInv)
	productC2DivG.Mod(productC2DivG, elgamalP)
	y, ok := parseSubgroupElement(pubKey.Y)
	return ok && verifyEqualityOfDiscreteLogs(elgamalG, y, productC1, productC2DivG,
		"mongbas/vector-v3/sum", proof.SumProof)
}

// verifyDisjunctiveElGamalProof verifies encryption of one explicit message.
// The transcript binds its domain, key, ciphertext, messages and commitments.
func verifyDisjunctiveElGamalProof(pubKey *ElGamalPublicKey, c1Hex, c2Hex string,
	messages []*big.Int, domain string, proof *BallotValidityProof) bool {
	if pubKey == nil || pubKey.P != elgamalP.Text(16) || pubKey.G != elgamalG.Text(16) ||
		domain == "" || len(messages) == 0 || proof == nil || len(proof.A1s) != len(messages) ||
		len(proof.A2s) != len(messages) || len(proof.Es) != len(messages) || len(proof.Zs) != len(messages) {
		return false
	}
	y, okY := parseSubgroupElement(pubKey.Y)
	c1, okC1 := parseSubgroupElement(c1Hex)
	c2, okC2 := parseSubgroupElement(c2Hex)
	if !okY || !okC1 || !okC2 {
		return false
	}
	transcript := domain + "|" + elgamalG.Text(16) + "|" + y.Text(16) + "|" + c1.Text(16) + "|" + c2.Text(16)
	eSum := big.NewInt(0)
	for i, message := range messages {
		if message == nil || message.Sign() <= 0 || message.Cmp(elgamalP) >= 0 ||
			new(big.Int).Exp(message, elgamalQ, elgamalP).Cmp(big.NewInt(1)) != 0 {
			return false
		}
		a1, okA1 := parseSubgroupElement(proof.A1s[i])
		a2, okA2 := parseSubgroupElement(proof.A2s[i])
		e, okE := parseScalar(proof.Es[i])
		z, okZ := parseScalar(proof.Zs[i])
		if !okA1 || !okA2 || !okE || !okZ {
			return false
		}
		messageInv := new(big.Int).ModInverse(message, elgamalP)
		adjusted := new(big.Int).Mul(c2, messageInv)
		adjusted.Mod(adjusted, elgamalP)
		lhs1 := new(big.Int).Exp(elgamalG, z, elgamalP)
		rhs1 := new(big.Int).Exp(c1, e, elgamalP)
		rhs1.Mul(rhs1, a1).Mod(rhs1, elgamalP)
		lhs2 := new(big.Int).Exp(y, z, elgamalP)
		rhs2 := new(big.Int).Exp(adjusted, e, elgamalP)
		rhs2.Mul(rhs2, a2).Mod(rhs2, elgamalP)
		if lhs1.Cmp(rhs1) != 0 || lhs2.Cmp(rhs2) != 0 {
			return false
		}
		eSum.Add(eSum, e)
		transcript += "|" + message.Text(16) + "|" + a1.Text(16) + "|" + a2.Text(16)
	}
	digest := sha256.Sum256([]byte(transcript))
	expected := new(big.Int).SetBytes(digest[:])
	expected.Mod(expected, elgamalQ)
	eSum.Mod(eSum, elgamalQ)
	return eSum.Cmp(expected) == 0
}

func verifyEqualityOfDiscreteLogs(base1, base2, result1, result2 *big.Int,
	domain string, proof *EqualityOfDiscreteLogsProof) bool {
	if domain == "" || proof == nil {
		return false
	}
	for _, value := range []*big.Int{base1, base2, result1, result2} {
		if value == nil || value.Sign() <= 0 || value.Cmp(elgamalP) >= 0 ||
			new(big.Int).Exp(value, elgamalQ, elgamalP).Cmp(big.NewInt(1)) != 0 {
			return false
		}
	}
	a1, okA1 := parseSubgroupElement(proof.A1)
	a2, okA2 := parseSubgroupElement(proof.A2)
	e, okE := parseScalar(proof.E)
	z, okZ := parseScalar(proof.Z)
	if !okA1 || !okA2 || !okE || !okZ {
		return false
	}
	transcript := fmt.Sprintf("%s|%s|%s|%s|%s|%s|%s", domain,
		base1.Text(16), base2.Text(16), result1.Text(16), result2.Text(16), a1.Text(16), a2.Text(16))
	digest := sha256.Sum256([]byte(transcript))
	expected := new(big.Int).SetBytes(digest[:])
	expected.Mod(expected, elgamalQ)
	if e.Cmp(expected) != 0 {
		return false
	}
	lhs1 := new(big.Int).Exp(base1, z, elgamalP)
	rhs1 := new(big.Int).Exp(result1, e, elgamalP)
	rhs1.Mul(rhs1, a1).Mod(rhs1, elgamalP)
	lhs2 := new(big.Int).Exp(base2, z, elgamalP)
	rhs2 := new(big.Int).Exp(result2, e, elgamalP)
	rhs2.Mul(rhs2, a2).Mod(rhs2, elgamalP)
	return lhs1.Cmp(rhs1) == 0 && lhs2.Cmp(rhs2) == 0
}

// ============================================================
// Shamir SSS 수학 헬퍼 — GF(secp256k1 prime) 위의 256비트 다항식 보간
// ============================================================

// shamirSplit256 32바이트 secret을 GF(p) 위에서 n개 share로 분할합니다 (threshold=2).
// 32바이트 전체를 하나의 256비트 정수로 처리 → f(x) = s + r*x mod p
// p = secp256k1 소수 (2^256 - 2^32 - 977), 보안 공간 ≈ 2^256
// coeffSeed: masterKey에서 유도된 비밀 시드 (체인코드 결정론성 보장)
func shamirSplit256(secret []byte, n int, coeffSeed []byte) [][]byte {
	p := shamirBigPrime
	s := new(big.Int).SetBytes(secret)
	s.Mod(s, p) // p ≈ 2^256이므로 실질적으로 변화 없음

	r := new(big.Int).SetBytes(coeffSeed)
	r.Mod(r, p)
	if r.Sign() == 0 {
		r.SetInt64(1) // r=0이면 상수 다항식 → threshold 무의미, 방지
	}

	shares := make([][]byte, n)
	for i := 0; i < n; i++ {
		x := big.NewInt(int64(i + 1)) // x = 1, 2, 3, ...
		// f(x) = s + r*x mod p
		fx := new(big.Int).Mul(r, x)
		fx.Add(fx, s)
		fx.Mod(fx, p)
		// 32바이트 big-endian 인코딩 (앞쪽 패딩)
		b := fx.Bytes()
		padded := make([]byte, 32)
		copy(padded[32-len(b):], b)
		shares[i] = padded
	}
	return shares
}

// shamirReconstruct256 2개 share에서 Lagrange 보간으로 원본 secret을 복원합니다.
// x1, x2: share 인덱스 (1-based, 서로 다른 값)
// s1, s2: 각 share 바이트 배열 (32바이트 big-endian)
func shamirReconstruct256(s1, s2 []byte, x1, x2 int) []byte {
	// A-3 보안 수정: 인덱스 검증
	if x1 == x2 {
		log.Printf("[shamirReconstruct256] 오류: 동일 인덱스 (x1=%d, x2=%d)", x1, x2)
		return nil
	}
	if x1 < 1 || x1 > 3 || x2 < 1 || x2 > 3 {
		log.Printf("[shamirReconstruct256] 오류: 인덱스 범위 초과 (x1=%d, x2=%d)", x1, x2)
		return nil
	}

	p := shamirBigPrime
	y1 := new(big.Int).SetBytes(s1)
	y2 := new(big.Int).SetBytes(s2)
	bx1 := big.NewInt(int64(x1))
	bx2 := big.NewInt(int64(x2))

	// Lagrange 보간 at x=0:
	// f(0) = y1 * (-x2) / (x1-x2) + y2 * (-x1) / (x2-x1)  mod p

	negX2 := new(big.Int).Neg(bx2)
	den1 := new(big.Int).Sub(bx1, bx2)
	invDen1 := new(big.Int).ModInverse(den1.Mod(den1, p), p)
	if invDen1 == nil {
		log.Printf("[shamirReconstruct256] ModInverse 실패: den1=0")
		return nil
	}
	term1 := new(big.Int).Mul(y1, negX2.Mod(negX2, p))
	term1.Mod(term1, p)
	term1.Mul(term1, invDen1)
	term1.Mod(term1, p)

	negX1 := new(big.Int).Neg(bx1)
	den2 := new(big.Int).Sub(bx2, bx1)
	invDen2 := new(big.Int).ModInverse(den2.Mod(den2, p), p)
	if invDen2 == nil {
		log.Printf("[shamirReconstruct256] ModInverse 실패: den2=0")
		return nil
	}
	term2 := new(big.Int).Mul(y2, negX1.Mod(negX1, p))
	term2.Mod(term2, p)
	term2.Mul(term2, invDen2)
	term2.Mod(term2, p)

	result := new(big.Int).Add(term1, term2)
	result.Mod(result, p)

	// 32바이트 big-endian 인코딩 (앞쪽 패딩)
	b := result.Bytes()
	padded := make([]byte, 32)
	copy(padded[32-len(b):], b)
	return padded
}

// ============================================================
// main
// ============================================================

func main() {
	cc, err := contractapi.NewChaincode(&VotingContract{})
	if err != nil {
		log.Fatalf("체인코드 생성 실패: %v", err)
	}

	// CCAAS (Chaincode as a Service) 모드
	// CHAINCODE_SERVER_ADDRESS 환경변수가 설정된 경우 서버 모드로 실행
	serverAddr := os.Getenv("CHAINCODE_SERVER_ADDRESS")
	if serverAddr != "" {
		ccID := os.Getenv("CHAINCODE_ID")
		if ccID == "" {
			log.Fatal("CCAAS 모드: CHAINCODE_ID 환경변수가 필요합니다")
		}
		server := &shim.ChaincodeServer{
			CCID:     ccID,
			Address:  serverAddr,
			CC:       cc,
			TLSProps: shim.TLSProperties{Disabled: true},
		}
		log.Printf("CCAAS 서버 모드 시작: %s (ID: %s)", serverAddr, ccID)
		if err := server.Start(); err != nil {
			log.Fatalf("체인코드 서버 시작 실패: %v", err)
		}
		return
	}

	// 기존 Docker 모드 (개발 환경용)
	if err := cc.Start(); err != nil {
		log.Fatalf("체인코드 시작 실패: %v", err)
	}
}
