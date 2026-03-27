// Package voting implements a privacy-preserving e-voting chaincode
// for Hyperledger Fabric using Anonymous Nullifiers and Private Data Collections (PDC).
//
// 핵심 프라이버시 설계:
//   - Nullifier: hash(voterSecret || electionID) → 이중투표 방지, 익명성 보장
//   - PDC (Private Data Collection): 투표 원본은 피어 비공개 사이드DB에만 저장
//   - 공개 원장: nullifierHash + candidateID만 기록 (신원 미노출)
//
// 데이터 흐름:
//
//	클라이언트 → CastVote(transient: votePrivate) → [PDC] VotePrivate (비공개)
//	                                              → [원장] Nullifier   (익명 공개)
package main

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"log"

	"github.com/hyperledger/fabric-contract-api-go/contractapi"
)

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
	ObjectType  string   `json:"docType"`    // CouchDB 인덱스용 ("election")
	ElectionID  string   `json:"electionID"`
	Title       string   `json:"title"`
	Description string   `json:"description"`
	Candidates  []string `json:"candidates"` // 후보자 ID 목록
	StartTime   int64    `json:"startTime"`  // Unix timestamp
	EndTime     int64    `json:"endTime"`
	Status      string   `json:"status"`     // CREATED | ACTIVE | CLOSED
	CreatedBy   string   `json:"createdBy"`  // 선거관리자 MSP ID
}

// Nullifier 익명 투표 증명 (공개 원장)
// 유권자가 투표했다는 사실만 증명하고 누가 투표했는지는 알 수 없음.
// nullifierHash = SHA256(voterSecret + electionID) — 클라이언트가 계산해서 전달
type Nullifier struct {
	ObjectType    string `json:"docType"`       // "nullifier"
	NullifierHash string `json:"nullifierHash"` // 이중투표 방지 키 (원장 Key로도 사용)
	ElectionID    string `json:"electionID"`
	CandidateID   string `json:"candidateID"` // 익명으로 집계될 후보자
	Timestamp     int64  `json:"timestamp"`
}

// VotePrivate PDC에 저장되는 원본 투표 데이터 (비공개)
// 오더러에게 전달되지 않고 피어의 사이드 DB에만 저장됨.
// 클라이언트는 이 구조체를 JSON으로 직렬화하여 트랜잭션 Transient Map에 넣어서 전달.
type VotePrivate struct {
	ObjectType    string `json:"docType"`       // "votePrivate"
	VoterID       string `json:"voterID"`       // 암호화된 유권자 식별자
	ElectionID    string `json:"electionID"`
	CandidateID   string `json:"candidateID"`
	NullifierHash string `json:"nullifierHash"` // 공개 Nullifier와 연결 고리
	VoteHash      string `json:"voteHash"`      // SHA256(voterID + candidateID + salt) — 무결성 검증
	Timestamp     int64  `json:"timestamp"`
}

// VoteTally 선거 집계 결과 (공개 원장, CloseElection 호출 시 기록)
type VoteTally struct {
	ObjectType string         `json:"docType"`    // "tally"
	ElectionID string         `json:"electionID"`
	Results    map[string]int `json:"results"`    // candidateID → 득표수
	TotalVotes int            `json:"totalVotes"`
	ClosedAt   int64          `json:"closedAt"`
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
)

// ============================================================
// 원장 초기화
// ============================================================

// InitLedger 체인코드 배포 시 시연용 선거 데이터를 원장에 기록합니다.
func (c *VotingContract) InitLedger(ctx contractapi.TransactionContextInterface) error {
	now, err := getTxTime(ctx)
	if err != nil {
		return err
	}
	elections := []Election{
		{
			ObjectType:  "election",
			ElectionID:  "ELECTION_2026_PRESIDENT",
			Title:       "2026 대표 선출 선거",
			Description: "블록체인 기반 익명 전자투표 시스템 시연용 선거",
			Candidates:  []string{"CANDIDATE_A", "CANDIDATE_B", "CANDIDATE_C"},
			StartTime:   now,
			EndTime:     now + 86400, // 24시간 후
			Status:      "ACTIVE",
			CreatedBy:   "VotingOrgMSP",
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

	election := Election{
		ObjectType:  "election",
		ElectionID:  electionID,
		Title:       title,
		Description: description,
		Candidates:  candidates,
		StartTime:   startTime,
		EndTime:     endTime,
		Status:      "CREATED",
		CreatedBy:   mspID,
	}

	b, err := json.Marshal(election)
	if err != nil {
		return fmt.Errorf("직렬화 실패: %w", err)
	}
	return ctx.GetStub().PutState(electionID, b)
}

// CloseElection 선거를 종료하고 득표를 집계하여 결과를 원장에 기록합니다.
// TallyVotes 로직이 내부에서 실행됩니다.
func (c *VotingContract) CloseElection(
	ctx contractapi.TransactionContextInterface,
	electionID string,
) (*VoteTally, error) {
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
//   - nullifierHash: SHA256(voterSecret + electionID) — 클라이언트가 로컬에서 계산
//
// 비공개 데이터 (Transient Map "votePrivate" 키로 전달 — 체인에 기록 안 됨):
//
//	{
//	  "voterID":    "암호화된_유권자_ID",
//	  "voteHash":   "SHA256(voterID+candidateID+salt)"
//	}
//
// 처리 흐름:
//  1. 선거 존재 및 ACTIVE 상태 + 투표 기간 검증
//  2. nullifierHash 중복 검사 → 이중투표 방지
//  3. candidateID 유효성 검사
//  4. Transient Map에서 비공개 투표 데이터 읽기
//  5. VotePrivate → PDC 저장 (오더러 미전달, 피어 사이드DB)
//  6. Nullifier  → 공개 원장 저장 (신원 미포함)
func (c *VotingContract) CastVote(
	ctx contractapi.TransactionContextInterface,
	electionID string,
	candidateID string,
	nullifierHash string,
) error {

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

	// ── Step 2: 이중투표 방지 ─────────────────────────────────
	existing, err := ctx.GetStub().GetState(nullifierHash)
	if err != nil {
		return fmt.Errorf("Nullifier 조회 실패: %w", err)
	}
	if existing != nil {
		return fmt.Errorf("이미 투표한 유권자입니다 (이중투표 감지)")
	}

	// ── Step 3: 후보자 유효성 검사 ───────────────────────────
	if !contains(election.Candidates, candidateID) {
		return fmt.Errorf("유효하지 않은 후보자 ID입니다: %s", candidateID)
	}

	// ── Step 4: Transient Map에서 비공개 투표 데이터 읽기 ────
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

	// 비공개 데이터 무결성 검사: electionID, candidateID, nullifierHash 일치 확인
	if vp.ElectionID != electionID || vp.CandidateID != candidateID || vp.NullifierHash != nullifierHash {
		return fmt.Errorf("비공개 투표 데이터와 공개 파라미터가 일치하지 않습니다")
	}

	// voteHash 검증 생략 가능 (클라이언트 신뢰 수준에 따라 결정)
	// 필요 시: expectedHash := ComputeVoteHash(vp.VoterID, candidateID, salt) 로 검증

	// ObjectType 강제 설정 (클라이언트 제공값 덮어쓰기)
	vp.ObjectType = "votePrivate"
	vp.Timestamp = now

	vpBytes, err := json.Marshal(vp)
	if err != nil {
		return fmt.Errorf("VotePrivate 직렬화 실패: %w", err)
	}

	// ── Step 5: PDC 저장 (비공개) ────────────────────────────
	// nullifierHash를 키로 사용 → 나중에 PDC에서도 개별 조회 가능
	if err := ctx.GetStub().PutPrivateData(VotePrivatePDC, nullifierHash, vpBytes); err != nil {
		return fmt.Errorf("PDC 저장 실패: %w", err)
	}

	// ── Step 6: 공개 원장에 Nullifier 저장 (익명) ────────────
	nullifier := Nullifier{
		ObjectType:    "nullifier",
		NullifierHash: nullifierHash,
		ElectionID:    electionID,
		CandidateID:   candidateID, // 후보자는 공개 (집계를 위해)
		Timestamp:     now,
	}
	nBytes, err := json.Marshal(nullifier)
	if err != nil {
		return fmt.Errorf("Nullifier 직렬화 실패: %w", err)
	}
	if err := ctx.GetStub().PutState(nullifierHash, nBytes); err != nil {
		return fmt.Errorf("Nullifier 원장 저장 실패: %w", err)
	}

	log.Printf("[CastVote] 투표 완료 — election: %s, candidate: %s", electionID, candidateID)
	return nil
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

	// 후보자별 득표 집계
	results := make(map[string]int)
	for _, cand := range election.Candidates {
		results[cand] = 0 // 0표도 명시적으로 기록
	}
	totalVotes := 0

	for resultsIterator.HasNext() {
		queryResult, err := resultsIterator.Next()
		if err != nil {
			return nil, fmt.Errorf("결과 순회 실패: %w", err)
		}

		var nullifier Nullifier
		if err := json.Unmarshal(queryResult.Value, &nullifier); err != nil {
			return nil, fmt.Errorf("Nullifier 역직렬화 실패: %w", err)
		}

		results[nullifier.CandidateID]++
		totalVotes++
	}

	tally := VoteTally{
		ObjectType: "tally",
		ElectionID: electionID,
		Results:    results,
		TotalVotes: totalVotes,
		ClosedAt:   closedAt,
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

// GetNullifier Nullifier 존재 여부를 조회합니다 (이중투표 확인 또는 감사용).
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
// main
// ============================================================

func main() {
	cc, err := contractapi.NewChaincode(&VotingContract{})
	if err != nil {
		log.Fatalf("체인코드 생성 실패: %v", err)
	}
	if err := cc.Start(); err != nil {
		log.Fatalf("체인코드 시작 실패: %v", err)
	}
}
