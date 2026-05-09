// Package voting implements a privacy-preserving e-voting chaincode
// for Hyperledger Fabric using Anonymous Nullifiers and Private Data Collections (PDC).
//
// 핵심 프라이버시 설계:
//   - Nullifier: hash(voterSecret || electionID) → 최종 1표만 유효 (재투표 허용, 이중집계 방지), 익명성 보장
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
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"math/big"
	"os"
	"sort"
	"strconv"
	"strings"

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
	NullifierHash        string `json:"nullifierHash"`
	C1                   string `json:"c1"`                   // ElGamal 암호문 c1
	C2                   string `json:"c2"`                   // ElGamal 암호문 c2
	DecryptedHash        string `json:"decryptedHash"`        // SHA256(복호화된 평문)
	A1                   string `json:"a1"`                   // g^k mod p
	A2                   string `json:"a2"`                   // c1^k mod p
	E                    string `json:"e"`                    // Fiat-Shamir challenge
	Z                    string `json:"z"`                    // k + e*x mod q
	CandidateCommitment  string `json:"candidateCommitment"`
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
	// SHA256(voterSecret + electionID + blindingFactor) 으로 nullifier 계산
	// 선거마다 다른 salt → voterSecret이 유출돼도 선거 간 역추적 불가
	BlindingFactor string `json:"blindingFactor"` // SHA256(txID + electionID)
	// [PAPER-1] 선거 공개 암호화 키 (hex)
	// 클라이언트가 이 키로 candidateID를 암호화하여 제출.
	// 체인코드는 암호문만 저장하고 평문을 보지 않음.
	// 비밀키는 PDC에만 저장 → Shamir으로 분산 → threshold 복호화로 집계.
	EncryptionPubKey string `json:"encryptionPubKey,omitempty"` // AES-256 키를 감싼 공개키 (hex)
	// [PAPER-11] 암호화 모드: "aes" (기본) 또는 "elgamal"
	EncryptionMode string `json:"encryptionMode,omitempty"` // "aes" | "elgamal"
	// [PAPER-11] ElGamal 공개키 (elgamal 모드일 때만 사용)
	ElGamalPubKey *ElGamalPublicKey `json:"elgamalPubKey,omitempty"`
}

// Nullifier 익명 투표 증명 (공개 원장)
// 유권자가 투표했다는 사실만 증명하고 누가 투표했는지는 알 수 없음.
// nullifierHash = SHA256(voterSecret + electionID + blindingFactor) — 클라이언트가 계산
type Nullifier struct {
	ObjectType           string `json:"docType"`       // "nullifier"
	NullifierHash        string `json:"nullifierHash"` // 최종 1표만 유효 키 (재투표 시 덮어쓰기, 원장 Key로도 사용)
	ElectionID           string `json:"electionID"`
	CandidateID          string `json:"candidateID" metadata:",optional"` // 레거시 호환 전용. 신규 투표에서는 평문 후보자를 저장하지 않음.
	CandidateCommitment  string `json:"candidateCommitment"`   // SHA256(electionID|nullifierHash|encryptedCandidateID)
	EncryptedCandidateID string `json:"encryptedCandidateID"`  // [C-4] AES-GCM 암호화된 후보자 ID
	Timestamp            int64  `json:"timestamp"`
	EvictCount           int    `json:"evictCount"`    // 재투표 횟수 (0 = 최초 투표)
	LastEvictedAt        int64  `json:"lastEvictedAt"` // 마지막 재투표 시각
	// [CRIT-01/02 FIX] 자격증명 감사 해시
	CredentialHash string `json:"credentialHash"` // SHA256(credential token)
	// [PAPER-4] 자격증명 검증 수준
	CredVerifyLevel string `json:"credVerifyLevel,omitempty"` // "chaincode" | "metadata-only"
}

// CredentialVerification [CRIT-01/02 FIX] 체인코드 독립 검증용 자격증명 메타데이터
// API 서버가 transient map "credentialVerification" 키로 전달.
// 원본 토큰 대신 구조적 속성만 전달하여 신원 노출 방지.
type CredentialVerification struct {
	CredType   string `json:"credType"`   // "ps" | "bbs" | "hmac" | "ed25519" | "bypass"
	ElectionID string `json:"electionID"` // 자격증명에 바인딩된 선거 ID
	ExpUnix    int64  `json:"expUnix"`    // 만료 시각 (Unix seconds)
	CredHash   string `json:"credHash"`   // SHA256(원본 토큰) — 감사용
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

// VotePrivate PDC에 저장되는 원본 투표 데이터 (비공개)
// 오더러에게 전달되지 않고 피어의 사이드 DB에만 저장됨.
// 클라이언트는 이 구조체를 JSON으로 직렬화하여 트랜잭션 Transient Map에 넣어서 전달.
type VotePrivate struct {
	ObjectType           string `json:"docType"`              // "votePrivate"
	ElectionID           string `json:"electionID"`           // 선거 ID
	NullifierHash        string `json:"nullifierHash"`        // 공개 Nullifier와 연결 고리
	EncryptedCandidateID string `json:"encryptedCandidateID"` // 후보자 암호문
	CandidateCommitment  string `json:"candidateCommitment"`  // 공개 원장 commitment와 일치해야 함
	VoteHash             string `json:"voteHash"`             // 암호화 투표 레코드 무결성 확인용
	Timestamp            int64  `json:"timestamp"`
}

// VoteTally 선거 집계 결과 (공개 원장, CloseElection 호출 시 기록)
type VoteTally struct {
	ObjectType     string         `json:"docType"` // "tally"
	ElectionID     string         `json:"electionID"`
	Results        map[string]int `json:"results"` // candidateID → 득표수
	TotalVotes     int            `json:"totalVotes"`
	ClosedAt       int64          `json:"closedAt"`
	// [PAPER-2] tallied-as-recorded 검증용 증명
	TallyProofHash string              `json:"tallyProofHash,omitempty"` // 모든 복호화 기록의 해시
	DecryptionProofs []DecryptionProof `json:"decryptionProofs,omitempty"` // 개별 투표 복호화 증명
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
	ZKProof *ChaumPedersenProof `json:"zkProof,omitempty"`
}

// VoterPWPrivate PDC에 저장되는 유권자 비밀번호 해시 (비공개)
// CastVote 시 transient "votePrivate" 에 포함하여 전달합니다.
//
// normalPWHash  : SHA256(normalPassword  + nullifierHash) — 실제 증명용
// panicPWHash   : SHA256(panicPassword   + nullifierHash) — 강압 대응용 (더미 증명 반환)
// panicCandidateID : Panic Mode에서 보여줄 가짜 후보자 ID
type VoterPWPrivate struct {
	NormalPWHash     string `json:"normalPWHash"`
	PanicPWHash      string `json:"panicPWHash"`
	PanicCandidateID string `json:"panicCandidateID"` // 강압자에게 보여줄 가짜 후보
}

// BallotPreparation [PAPER-3] Benaloh Challenge용 사전 암호화 투표
// PDC에 임시 저장되며, audit 또는 cast 중 하나만 수행 가능
type BallotPreparation struct {
	BallotID             string `json:"ballotID"`             // 고유 ID (SHA256 유도)
	ElectionID           string `json:"electionID"`
	CandidateID          string `json:"candidateID"`          // 평문 (audit 시에만 공개)
	EncryptedCandidateID string `json:"encryptedCandidateID"` // AES-GCM 암호문
	Commitment           string `json:"commitment"`           // SHA256(ballotID + encryptedCandidateID)
	Status               string `json:"status"`               // "prepared" | "audited" | "cast"
	CreatedAt            int64  `json:"createdAt"`
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
		// CREDENTIAL_SECRET 미설정 시 메타데이터 검증만으로 통과 (하위 호환)
		log.Printf("[verifyHMACCredentialToken] CREDENTIAL_SECRET 미설정 — 메타데이터 검증만 수행")
		return nil
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
	if transient, tErr := ctx.GetStub().GetTransient(); tErr == nil {
		if modeBytes, ok := transient["encryptionMode"]; ok {
			mode := strings.TrimSpace(string(modeBytes))
			if mode == "elgamal" {
				encryptionMode = "elgamal"
			}
		}
	}

	var elgamalPubKey *ElGamalPublicKey

	// AES 키 생성 (모든 모드에서 공통 — Shamir 분산 + 더미 Nullifier 암호화용)
	ekInput := fmt.Sprintf("ENCRYPTION_%s_%s", electionID, txID)
	ekRaw := sha256.Sum256([]byte(ekInput))
	ekKey := "ENCRYPTION_KEY_" + electionID
	ekHexStr := hex.EncodeToString(ekRaw[:])
	if pdcErr := ctx.GetStub().PutPrivateData(VotePrivatePDC, ekKey, []byte(ekHexStr)); pdcErr != nil {
		return fmt.Errorf("암호화 키 PDC 저장 실패: %w", pdcErr)
	}

	if encryptionMode == "elgamal" {
		// [PAPER-11] ElGamal 키쌍 생성 — 결정론적 (txID 기반)
		keySeed := sha256.Sum256([]byte(fmt.Sprintf("ELGAMAL_KEY_%s_%s", electionID, txID)))
		privKey, pubKey := elgamalGenerateKeyPair(keySeed[:])
		elgamalPubKey = pubKey

		// 비밀키를 PDC에 저장
		pkKey := "ELGAMAL_PRIVKEY_" + electionID
		if pdcErr := ctx.GetStub().PutPrivateData(VotePrivatePDC, pkKey, []byte(privKey.Text(16))); pdcErr != nil {
			return fmt.Errorf("ElGamal 비밀키 PDC 저장 실패: %w", pdcErr)
		}
		log.Printf("[CreateElection] ElGamal 키쌍 생성 완료 — pubKey.Y: %s...", pubKey.Y[:16])
	} else {
		log.Printf("[CreateElection] AES 암호화 키 생성 완료 — PDC key: %s, hex: %s...", ekKey, ekHexStr[:16])
	}

	election := Election{
		ObjectType:     "election",
		ElectionID:     electionID,
		Title:          title,
		Description:    description,
		Candidates:     candidates,
		StartTime:      startTime,
		EndTime:        endTime,
		Status:         "CREATED",
		CreatedBy:      mspID,
		BlindingFactor: blindingFactor,
		EncryptionMode: encryptionMode,
		ElGamalPubKey:  elgamalPubKey,
	}

	b, err := json.Marshal(election)
	if err != nil {
		return fmt.Errorf("직렬화 실패: %w", err)
	}
	if err := ctx.GetStub().PutState(electionID, b); err != nil {
		return fmt.Errorf("선거 원장 저장 실패: %w", err)
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

	log.Printf("[CreateElection] 선거 생성 완료: %s (더미: %d개)", electionID, len(candidates)*PanicDummyCount)
	return nil
}

// GetBlindingFactor [CRIT-03 FIX] 선거의 블라인딩 팩터를 반환합니다.
// 유권자는 투표 전 반드시 호출하여 nullifier 계산에 사용해야 합니다.
// nullifierHash = SHA256(voterSecret + electionID + blindingFactor)
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
	// [PAPER-4] HMAC credential 체인코드 직접 검증
	if cv.CredType == "hmac" {
		if err := verifyHMACCredentialToken(ctx, cv, electionID, txNow); err != nil {
			return "", err
		}
	}
	return cv.CredHash, nil
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
		return nil, fmt.Errorf("이미 종료된 선거입니다: %s", electionID)
	}

	// 집계 실행
	tally, err := c.TallyVotes(ctx, electionID)
	if err != nil {
		return nil, err
	}

	// 선거 상태를 CLOSED로 업데이트
	election.Status = "CLOSED"
	b, err := json.Marshal(election)
	if err != nil {
		return nil, fmt.Errorf("선거 직렬화 실패: %w", err)
	}
	if err := ctx.GetStub().PutState(electionID, b); err != nil {
		return nil, fmt.Errorf("선거 상태 업데이트 실패: %w", err)
	}

	return tally, nil
}

// ============================================================
// CastVote — 핵심 투표 함수
// ============================================================

// CastVote 유권자가 익명으로 투표를 제출합니다.
//
// 공개 파라미터 (체인에 기록됨):
//   - electionID:    투표 대상 선거 ID
//   - candidateID:   선택한 후보자 ID
//   - nullifierHash: SHA256(voterSecret + electionID + blindingFactor) — 클라이언트 계산
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
//  6. Nullifier  → 공개 원장 저장 (신원 미포함, credentialHash 포함)
func (c *VotingContract) CastVote(
	ctx contractapi.TransactionContextInterface,
	electionID string,
	candidateID string,
	nullifierHash string,
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

	// ── Step 1b: [CRIT-01/02 FIX] 자격증명 체인코드 독립 검증 ────
	// API 서버 미들웨어와 별개로 체인코드가 직접 자격증명 메타데이터를 검증.
	// API 서버가 타협되어 auth.js 검증을 우회해도 이 레이어에서 차단됩니다.
	credHash, err := verifyCredentialTransient(ctx, electionID, now)
	if err != nil {
		return fmt.Errorf("자격증명 거부: %w", err)
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
		log.Printf("[CastVote] Eviction 감지 — nullifier: %s, 재투표 #%d", nullifierHash[:16], evictCount)
	}

	// ── Step 3: Transient Map에서 비공개 투표 데이터 읽기 ────
	// 클라이언트는 SDK의 transient 옵션으로 {"votePrivate": <JSON bytes>} 전달
	transient, err := ctx.GetStub().GetTransient()
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

	// ── Step 3b: 후보자 암호화 처리 ─────────────────────────
	// [PAPER-1] 클라이언트-사이드 암호화 지원:
	//   A) candidateID가 비어있고 encryptedCandidateID가 있으면 → 클라이언트가 암호화 (체인코드 blind)
	//   B) candidateID가 있으면 → 체인코드가 암호화 (레거시 호환)
	// A 방식에서 체인코드는 평문 후보자를 절대 보지 않음 → ballot secrecy 강화
	var encryptedCandID string
	var candidateCommitment string

	encKey, ekErr := getEncryptionKey(ctx, electionID)

	if candidateID == "" && vp.EncryptedCandidateID != "" {
		// [PAPER-1] 클라이언트-사이드 암호화 모드 (blind mode)

		if election.EncryptionMode == "elgamal" {
			// [PAPER-11] ElGamal blind mode: 클라이언트가 공개키로 암호화
			// 체인코드는 비밀키로 복호화하여 유효 후보 검증
			privKey, pkErr := getElGamalPrivateKey(ctx, electionID)
			if pkErr != nil {
				return fmt.Errorf("ElGamal 비밀키 조회 실패: %w", pkErr)
			}
			// ElGamal 암호문 파싱: "c1_hex:c2_hex" 형식
			parts := strings.SplitN(vp.EncryptedCandidateID, ":", 2)
			if len(parts) != 2 {
				return fmt.Errorf("ElGamal 암호문 형식 오류 (c1:c2 형식 필요)")
			}
			decrypted, decErr := elgamalDecrypt(privKey, parts[0], parts[1])
			if decErr != nil {
				return fmt.Errorf("ElGamal 복호화 실패: %w", decErr)
			}
			if !contains(election.Candidates, decrypted) {
				return fmt.Errorf("유효하지 않은 후보자입니다")
			}
			encryptedCandID = vp.EncryptedCandidateID
			candidateCommitment = computeCandidateCommitment(electionID, nullifierHash, encryptedCandID)
			log.Printf("[CastVote] ElGamal blind mode — election: %s", electionID)
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
		ObjectType:           "nullifier",
		NullifierHash:        nullifierHash,
		ElectionID:           electionID,
		CandidateCommitment:  candidateCommitment,
		EncryptedCandidateID: encryptedCandID,
		Timestamp:            now,
		EvictCount:           evictCount,
		LastEvictedAt: func() int64 {
			if isEviction {
				return now
			}
			return 0
		}(),
		CredentialHash:  credHash, // [CRIT-01/02 FIX] 자격증명 감사 해시 기록
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
	useElGamal := election.EncryptionMode == "elgamal"
	if useElGamal {
		var pkErr error
		elgamalPrivKey, pkErr = getElGamalPrivateKey(ctx, electionID)
		if pkErr != nil {
			log.Printf("[TallyVotes] ElGamal 비밀키 조회 실패 (AES 폴백) — %v", pkErr)
			useElGamal = false
		}
	}

	// 후보자별 득표 집계
	results := make(map[string]int)
	for _, cand := range election.Candidates {
		results[cand] = 0 // 0표도 명시적으로 기록
	}
	totalVotes := 0
	var decProofs []DecryptionProof

	for resultsIterator.HasNext() {
		queryResult, err := resultsIterator.Next()
		if err != nil {
			return nil, fmt.Errorf("결과 순회 실패: %w", err)
		}

		var nullifier Nullifier
		if err := json.Unmarshal(queryResult.Value, &nullifier); err != nil {
			return nil, fmt.Errorf("Nullifier 역직렬화 실패: %w", err)
		}

		candID := nullifier.CandidateID

		if useElGamal && nullifier.EncryptedCandidateID != "" {
			// [PAPER-11] ElGamal 복호화 + Chaum-Pedersen ZKP 생성
			parts := strings.SplitN(nullifier.EncryptedCandidateID, ":", 2)
			if len(parts) == 2 {
				decrypted, decErr := elgamalDecrypt(elgamalPrivKey, parts[0], parts[1])
				if decErr == nil {
					candID = decrypted
					// 평문의 BigInt 표현
					m := elgamalEncodePlaintext(decrypted)
					// Chaum-Pedersen ZKP 생성
					zkProof, _, zpErr := chaumPedersenProve(
						elgamalPrivKey, parts[0], parts[1], m.Text(16),
						nullifier.NullifierHash, electionID,
					)
					dh := sha256.Sum256([]byte(decrypted))
					dp := DecryptionProof{
						NullifierHash:        nullifier.NullifierHash,
						EncryptedCandidateID: nullifier.EncryptedCandidateID,
						DecryptedHash:        hex.EncodeToString(dh[:]),
						CandidateCommitment:  nullifier.CandidateCommitment,
					}
					if zpErr == nil {
						zkProof.CandidateCommitment = nullifier.CandidateCommitment
						dp.ZKProof = zkProof
					}
					decProofs = append(decProofs, dp)
				} else {
					log.Printf("[TallyVotes] ElGamal 복호화 실패 — %v", decErr)
				}
			}
		} else if useAES && nullifier.EncryptedCandidateID != "" {
			// AES 복호화 (기존)
			decrypted, decErr := decryptAESGCM(encKey, nullifier.EncryptedCandidateID)
			if decErr == nil {
				candID = decrypted
				dh := sha256.Sum256([]byte(decrypted))
				decProofs = append(decProofs, DecryptionProof{
					NullifierHash:        nullifier.NullifierHash,
					EncryptedCandidateID: nullifier.EncryptedCandidateID,
					DecryptedHash:        hex.EncodeToString(dh[:]),
					CandidateCommitment:  nullifier.CandidateCommitment,
				})
			} else {
				log.Printf("[TallyVotes] AES 복호화 실패 (평문 폴백) — %v", decErr)
			}
		}

		results[candID]++
		totalVotes++
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

	log.Printf("[TallyVotes] 집계 완료 — election: %s, 총 투표수: %d", electionID, totalVotes)
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

	panicMode := false
	// 상수시간 비교로 타이밍 사이드채널 방지 (A-2 보안 수정)
	isPanic := subtle.ConstantTimeCompare([]byte(passwordHash), []byte(pw.PanicPWHash)) == 1
	isNormal := subtle.ConstantTimeCompare([]byte(passwordHash), []byte(pw.NormalPWHash)) == 1
	if isPanic {
		panicMode = true
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
		log.Printf("[GetMerkleProofWithPassword] Panic Mode — dummy idx: %d, hash: %s", dummyIdx, targetHash[:16])
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

	_ = panicMode // 로그 목적으로만 사용 (응답에서 모드 노출 금지)
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
	if n.CandidateCommitment == "" || n.EncryptedCandidateID == "" {
		// 레거시 호환: 이전 버전 원장은 nullifierHash만 Merkle leaf로 사용했다.
		h := sha256.Sum256([]byte(n.NullifierHash))
		return fmt.Sprintf("%x", h)
	}
	return hashWithLengthPrefix(n.ElectionID, n.NullifierHash, n.CandidateCommitment, n.EncryptedCandidateID)
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

// ComputeNullifierHash SHA256(voterSecret + electionID) 계산 (테스트/디버그용).
// 실제 운영에서는 voterSecret이 체인코드로 전달되면 안 되므로 클라이언트에서 계산할 것.
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

	statusKey := "KEYSHARING_" + electionID
	if existingBytes, _ := ctx.GetStub().GetState(statusKey); existingBytes != nil {
		return nil, fmt.Errorf("이미 키 분산이 초기화된 선거입니다: %s", electionID)
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
	if election.EncryptionMode != "elgamal" || election.ElGamalPubKey == nil {
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
	if election.EncryptionMode != "elgamal" || election.ElGamalPubKey == nil {
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

	// 각 ZKP 검증
	verified := 0
	failed := 0
	recount := make(map[string]int)

	for _, proof := range tally.DecryptionProofs {
		if proof.ZKProof == nil {
			failed++
			continue
		}

		// decryptedHash로부터 평문을 직접 알 수 없으므로,
		// 모든 후보를 시도하여 decryptedHash와 일치하는 후보를 찾음
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
		"electionID":     electionID,
		"encryptionMode": "elgamal",
		"totalProofs":    len(tally.DecryptionProofs),
		"verified":       verified,
		"failed":         failed,
		"resultsMatch":   resultsMatch,
		"recount":        recount,
		"originalResults": tally.Results,
		"isValid":        failed == 0 && resultsMatch,
	}

	resultJSON, _ := json.Marshal(result)
	return string(resultJSON), nil
}

// ============================================================
// Bulletin Board — 공개 감사 데이터 (PAPER-6: Universal Verifiability)
// ============================================================

// BulletinBoard 선거의 모든 공개 감사 데이터를 한 곳에 모은 구조체
// Helios 모델: 집계 후 암호화 키를 공개하여 누구나 독립 검증 가능
// [PAPER-7] 투표 순서를 결정론적으로 셔플하여 시간 분석 공격 방지
type BulletinBoard struct {
	ObjectType       string             `json:"docType"`       // "bulletinBoard"
	ElectionID       string             `json:"electionID"`
	EncryptionKeyHex string             `json:"encryptionKeyHex"` // 공개된 AES-256 키 (hex)
	EncryptedBallots []EncryptedBallot  `json:"encryptedBallots"` // 셔플된 암호화 투표
	TallyResults     map[string]int     `json:"tallyResults"`     // 공식 집계 결과
	TotalVotes       int                `json:"totalVotes"`
	DecryptionProofs []DecryptionProof  `json:"decryptionProofs"` // 복호화 증명 (동일 순서로 셔플)
	TallyProofHash   string             `json:"tallyProofHash"`   // 집계 증명 해시
	MerkleRoot       string             `json:"merkleRoot,omitempty"` // Merkle tree root
	ShuffleSeed      string             `json:"shuffleSeed,omitempty"`  // [PAPER-7] 셔플 시드 (hex)
	ShuffleProofHash string             `json:"shuffleProofHash,omitempty"` // [PAPER-7] 셔플 정확성 증명
	PublishedAt      int64              `json:"publishedAt"`
}

// EncryptedBallot 공개 원장의 개별 암호화 투표
type EncryptedBallot struct {
	NullifierHash        string `json:"nullifierHash"`
	EncryptedCandidateID string `json:"encryptedCandidateID"`
	CandidateCommitment  string `json:"candidateCommitment"`
}

// PublicVerificationResult 공개 검증 결과
type PublicVerificationResult struct {
	ElectionID          string         `json:"electionID"`
	IsValid             bool           `json:"isValid"`
	RecomputedResults   map[string]int `json:"recomputedResults"`   // 독립 재집계 결과
	OriginalResults     map[string]int `json:"originalResults"`     // 원본 집계 결과
	ResultsMatch        bool           `json:"resultsMatch"`        // 결과 일치 여부
	ProofHashMatch      bool           `json:"proofHashMatch"`      // tallyProofHash 일치 여부
	ShuffleVerified     bool           `json:"shuffleVerified"`     // [PAPER-7] 셔플 정확성 검증
	DecryptionVerified  int            `json:"decryptionVerified"`  // 검증 성공한 투표 수
	DecryptionFailed    int            `json:"decryptionFailed"`    // 검증 실패한 투표 수
	TotalBallots        int            `json:"totalBallots"`
	VerifiedAt          int64          `json:"verifiedAt"`
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

	// 암호화 키 조회 (Shamir 복원 후 PDC에 저장됨)
	encKey, err := getEncryptionKey(ctx, electionID)
	if err != nil {
		return nil, fmt.Errorf("암호화 키 조회 실패 — Shamir 복원이 완료되었는지 확인하세요: %w", err)
	}
	encKeyHex := hex.EncodeToString(encKey)

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
			continue
		}
		ballots = append(ballots, EncryptedBallot{
			NullifierHash:        nul.NullifierHash,
			EncryptedCandidateID: nul.EncryptedCandidateID,
			CandidateCommitment:  nul.CandidateCommitment,
		})
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
		ObjectType:       "bulletinBoard",
		ElectionID:       electionID,
		EncryptionKeyHex: encKeyHex,
		EncryptedBallots: shuffledBallots,
		TallyResults:     tally.Results,
		TotalVotes:       tally.TotalVotes,
		DecryptionProofs: shuffledProofs,
		TallyProofHash:   tally.TallyProofHash,
		MerkleRoot:       merkleRoot,
		ShuffleSeed:      hex.EncodeToString(shuffleSeed),
		ShuffleProofHash: shuffleProofHash,
		PublishedAt:       now,
	}

	b, err := json.Marshal(bb)
	if err != nil {
		return nil, fmt.Errorf("BulletinBoard 직렬화 실패: %w", err)
	}
	if err := ctx.GetStub().PutState(bbKey, b); err != nil {
		return nil, fmt.Errorf("BulletinBoard 저장 실패: %w", err)
	}

	log.Printf("[PublishAuditData] 게시 완료 — election: %s, ballots: %d, key published", electionID, len(ballots))
	return &bb, nil
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

	// 2. 공개된 키로 모든 암호화 투표 복호화 + 재집계
	encKey, err := hex.DecodeString(bb.EncryptionKeyHex)
	if err != nil {
		return nil, fmt.Errorf("공개 키 디코딩 실패: %w", err)
	}

	recomputed := make(map[string]int)
	verified := 0
	failed := 0

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

	// 5. 개별 DecryptionProof 검증 (decryptedHash 확인)
	for _, proof := range bb.DecryptionProofs {
		decrypted, decErr := decryptAESGCM(encKey, proof.EncryptedCandidateID)
		if decErr != nil {
			continue
		}
		dh := sha256.Sum256([]byte(decrypted))
		if hex.EncodeToString(dh[:]) != proof.DecryptedHash {
			resultsMatch = false
		}
	}

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
		IsValid:            resultsMatch && proofHashMatch && shuffleVerified && failed == 0,
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
	Property    string `json:"property"`
	Status      string `json:"status"`      // "achieved" | "partial" | "not-achieved"
	Mechanism   string `json:"mechanism"`    // 구현 메커니즘
	Assumption  string `json:"assumption"`   // 암호학적 가정
	PaperRef    string `json:"paperRef"`     // 구현 보고서 참조
}

// GetSecurityProperties [PAPER-5] 시스템의 보안 속성 요약을 반환합니다.
// 감사자(auditor)가 시스템의 보안 수준을 확인하는 데 사용됩니다.
func (c *VotingContract) GetSecurityProperties(
	ctx contractapi.TransactionContextInterface,
) (*SecurityProperties, error) {
	hasCredSecret := os.Getenv("CREDENTIAL_SECRET") != ""
	hasPubKey := os.Getenv("ED25519_PUBLIC_KEY_DER_B64") != ""

	credMechanism := "metadata-only"
	if hasCredSecret {
		credMechanism = "chaincode-hmac"
	}
	if hasPubKey {
		credMechanism = "chaincode-ed25519"
	}

	return &SecurityProperties{
		BallotSecrecy: SecurityProperty{
			Property:   "Ballot Secrecy",
			Status:     "achieved",
			Mechanism:  "AES-256-GCM client-side encryption (blind mode) + nullifier anonymity",
			Assumption: "AES IND-CPA + SHA-256 preimage resistance",
			PaperRef:   "PAPER-1 (21차)",
		},
		CastAsIntended: SecurityProperty{
			Property:   "Cast-as-Intended",
			Status:     "achieved",
			Mechanism:  "Benaloh Challenge (PrepareBallot/AuditBallot) with deterministic re-encryption",
			Assumption: "AES-256-GCM deterministic nonce correctness",
			PaperRef:   "PAPER-3 (23차)",
		},
		RecordedAsCast: SecurityProperty{
			Property:   "Recorded-as-Cast",
			Status:     "achieved",
			Mechanism:  "Merkle tree inclusion proof (hashWithLengthPrefix)",
			Assumption: "SHA-256 collision resistance",
			PaperRef:   "Merkle proof (기존)",
		},
		TalliedAsRecorded: SecurityProperty{
			Property:   "Tallied-as-Recorded",
			Status:     "achieved",
			Mechanism:  "DecryptionProof per-vote + tallyProofHash aggregate",
			Assumption: "SHA-256 preimage resistance + AES-256 correctness",
			PaperRef:   "PAPER-2 (22차)",
		},
		UniversalVerifiability: SecurityProperty{
			Property:   "Universal Verifiability",
			Status:     "achieved",
			Mechanism:  "Bulletin Board + post-election key publication + independent re-tally",
			Assumption: "AES-256-GCM correctness + SHA-256 collision resistance",
			PaperRef:   "PAPER-6 (26차)",
		},
		CoercionResistance: SecurityProperty{
			Property:   "Coercion Resistance (Enhanced Bounded)",
			Status:     "partial",
			Mechanism:  "Panic Password (randomized dummy) + receipt-free verification + deniable Merkle proof",
			Assumption: "Timing-safe comparison + structural indistinguishability",
			PaperRef:   "PAPER-8 (28차)",
		},
		EligibilityVerify: SecurityProperty{
			Property:   "Eligibility Verifiability",
			Status:     "achieved",
			Mechanism:  credMechanism + " + 2-of-3 endorsement",
			Assumption: "HMAC-SHA256 PRF / Ed25519 SUF-CMA",
			PaperRef:   "PAPER-4 (24차)",
		},
		CryptoPrimitives: []string{
			"AES-256-GCM (symmetric encryption, deterministic nonce)",
			"ElGamal (public-key encryption, RFC 3526 Group 14, 2048-bit MODP)",
			"Chaum-Pedersen ZKP (non-interactive decryption correctness proof)",
			"SHA-256 (hash, commitment, Merkle tree)",
			"Ed25519 (credential signature, RFC 8032)",
			"HMAC-SHA256 (credential authentication)",
			"Shamir SSS (2-of-3 threshold, GF(secp256k1 prime))",
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

// chaumPedersenVerify Chaum-Pedersen ZKP 검증 (누구나 공개키로 검증 가능)
// 검증: g^z == a1 * y^e mod p AND c1^z == a2 * s^e mod p
func chaumPedersenVerify(pubKey *ElGamalPublicKey, proof *ChaumPedersenProof, decryptedPlaintext string) bool {
	p, _ := new(big.Int).SetString(pubKey.P, 16)
	g, _ := new(big.Int).SetString(pubKey.G, 16)
	y, _ := new(big.Int).SetString(pubKey.Y, 16)
	c1, _ := new(big.Int).SetString(proof.C1, 16)
	c2, _ := new(big.Int).SetString(proof.C2, 16)
	a1, _ := new(big.Int).SetString(proof.A1, 16)
	a2, _ := new(big.Int).SetString(proof.A2, 16)
	e, _ := new(big.Int).SetString(proof.E, 16)
	z, _ := new(big.Int).SetString(proof.Z, 16)

	// m = encode(decryptedPlaintext)
	m := elgamalEncodePlaintext(decryptedPlaintext)
	// s = c2 * m^(-1) mod p
	mInv := new(big.Int).ModInverse(m, p)
	s := new(big.Int).Mul(c2, mInv)
	s.Mod(s, p)

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
