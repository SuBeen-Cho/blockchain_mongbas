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
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"sort"
	"strconv"

	"github.com/hyperledger/fabric-chaincode-go/shim"
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
	EvictCount    int    `json:"evictCount"`    // 재투표 횟수 (0 = 최초 투표)
	LastEvictedAt int64  `json:"lastEvictedAt"` // 마지막 재투표 시각
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

// VoterPWPrivate PDC에 저장되는 유권자 비밀번호 해시 (비공개)
// CastVote 시 transient "votePrivate" 에 포함하여 전달합니다.
//
// normalPWHash  : SHA256(normalPassword  + nullifierHash) — 실제 증명용
// panicPWHash   : SHA256(panicPassword   + nullifierHash) — 강압 대응용 (더미 증명 반환)
// panicCandidateID : Panic Mode에서 보여줄 가짜 후보자 ID
type VoterPWPrivate struct {
	NormalPWHash    string `json:"normalPWHash"`
	PanicPWHash     string `json:"panicPWHash"`
	PanicCandidateID string `json:"panicCandidateID"` // 강압자에게 보여줄 가짜 후보
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
	ShamirThreshold   = 2   // 복원에 필요한 최소 share 수
	ShamirTotalShares = 3   // 총 share 수 (3개 조직)
	ShamirPrime       = 257 // 소수 (> 255, 바이트 범위 포함)
)

// KeySharingStatus Shamir SSS 키 분산 현황 (공개 원장)
type KeySharingStatus struct {
	ObjectType     string   `json:"docType"`        // "keySharingStatus"
	ElectionID     string   `json:"electionID"`
	Threshold      int      `json:"threshold"`      // 복원 임계값 (2)
	TotalShares    int      `json:"totalShares"`    // 총 share 수 (3)
	SubmittedCount int      `json:"submittedCount"` // 제출된 share 수
	SubmittedBy    []string `json:"submittedBy"`    // 제출한 share 인덱스 목록 ("1","2","3")
	IsDecrypted    bool     `json:"isDecrypted"`    // 복원 성공 여부
	KeyHash        string   `json:"keyHash"`        // SHA256(masterKey) — 검증용 공개
	InitiatedAt    int64    `json:"initiatedAt"`
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
	if err := ctx.GetStub().PutState(electionID, b); err != nil {
		return fmt.Errorf("선거 원장 저장 실패: %w", err)
	}

	// ── Panic Mode용 더미 Nullifier 생성 ─────────────────────────
	// 후보자별 PanicDummyCount개의 더미 Nullifier를 실제 Nullifier 레코드로 저장합니다.
	// 더미도 Merkle Tree 리프에 포함되어 강압자가 수학적으로 검증해도 통과합니다.
	// 더미 Nullifier 키: "DUMMY_{electionID}_{candidateID}_{index}"
	txID := ctx.GetStub().GetTxID()
	now, err := getTxTime(ctx)
	if err != nil {
		return err
	}
	for _, cand := range candidates {
		for i := 0; i < PanicDummyCount; i++ {
			rawKey := fmt.Sprintf("DUMMY_%s_%s_%d_%s", electionID, cand, i, txID)
			h := sha256.Sum256([]byte(rawKey))
			dummyHash := fmt.Sprintf("%x", h)

			dummy := Nullifier{
				ObjectType:    "nullifier",
				NullifierHash: dummyHash,
				ElectionID:    electionID,
				CandidateID:   cand,
				Timestamp:     now,
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

	// ── Step 2: 이중투표 확인 / Eviction 처리 ─────────────────
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
	nullifier := Nullifier{
		ObjectType:    "nullifier",
		NullifierHash: nullifierHash,
		ElectionID:    electionID,
		CandidateID:   candidateID,
		Timestamp:     now,
		EvictCount:    evictCount,
		LastEvictedAt: func() int64 { if isEviction { return now }; return 0 }(),
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
	NullifierHash string       `json:"nullifierHash"` // 증명 대상 nullifier (Panic Mode에서는 더미)
	CandidateID   string       `json:"candidateID"`   // 해당 nullifier의 후보자 ID
	Proof         []MerkleNode `json:"proof"`         // Merkle 포함 증명 경로
}

// MerkleRoot 선거별 Merkle Root 정보 (공개 원장, 키: "MERKLE_ROOT_<electionID>")
type MerkleRoot struct {
	ObjectType string `json:"docType"`    // "merkleRoot"
	ElectionID string `json:"electionID"`
	RootHash   string `json:"rootHash"`
	LeafCount  int    `json:"leafCount"`  // 집계된 투표 수 (= Merkle 리프 수)
	CreatedAt  int64  `json:"createdAt"`
}

// ============================================================
// STEP 2: Merkle Tree — 투표 무결성 E2E 검증 지원
// ============================================================

// BuildMerkleTree 선거의 모든 Nullifier Hash로 Merkle Tree를 구축하고
// Root Hash를 원장에 기록합니다. CloseElection 이후에 호출해야 합니다.
//
// 원장 키: "MERKLE_ROOT_{electionID}"
//
// 결정론적 구성:
//   - 리프를 nullifierHash 알파벳 순으로 정렬
//   - 홀수 리프일 경우 마지막 리프를 복제하여 짝수로 맞춤
//   - 각 내부 노드: SHA256(leftHash + rightHash)
func (c *VotingContract) BuildMerkleTree(
	ctx contractapi.TransactionContextInterface,
	electionID string,
) (*MerkleRoot, error) {
	// 선거 존재 + 종료 상태 확인
	election, err := c.GetElection(ctx, electionID)
	if err != nil {
		return nil, err
	}
	if election.Status != "CLOSED" {
		return nil, fmt.Errorf("Merkle Tree는 선거 종료(CLOSED) 후에만 구축할 수 있습니다 (현재 상태: %s)", election.Status)
	}

	// 해당 선거의 모든 Nullifier Hash 수집
	leaves, err := collectNullifierHashes(ctx, electionID)
	if err != nil {
		return nil, err
	}
	if len(leaves) == 0 {
		return nil, fmt.Errorf("투표 기록이 없어 Merkle Tree를 구축할 수 없습니다: %s", electionID)
	}

	// 결정론적 정렬
	sort.Strings(leaves)

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

	// 해당 선거의 모든 Nullifier Hash 수집 후 정렬
	leaves, err := collectNullifierHashes(ctx, electionID)
	if err != nil {
		return nil, err
	}
	sort.Strings(leaves)

	// 요청한 nullifierHash가 리프에 있는지 확인
	leafIdx := -1
	for i, h := range leaves {
		if h == nullifierHash {
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
// - normalPassword와 panicPassword는 클라이언트가 SHA256(password + nullifierHash)로 계산해서 전달합니다.
// - normalPWHash 일치 → 실제 nullifierHash의 Merkle 포함 증명 반환 (Normal Mode)
// - panicPWHash  일치 → 더미 nullifierHash의 포함 증명 반환 (Panic Mode)
//   더미도 Merkle Tree의 실제 리프이므로, 강압자가 검증해도 수학적으로 통과합니다.
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
		return &MerkleProofResult{NullifierHash: nullifierHash, CandidateID: n.CandidateID, Proof: proof}, nil
	}

	var pw VoterPWPrivate
	if err := json.Unmarshal(pwBytes, &pw); err != nil {
		return nil, fmt.Errorf("VoterPWPrivate 역직렬화 실패: %w", err)
	}

	// ── 3. 비밀번호 일치 여부 확인 ───────────────────────────
	// 어느 모드인지 확인 (Normal vs Panic)
	targetHash := nullifierHash

	panicMode := false
	if passwordHash == pw.PanicPWHash {
		panicMode = true
		// ── Panic Mode: 더미 nullifier 반환 ─────────────────
		// panicCandidateID에 해당하는 더미 nullifier 중 0번째 사용
		dummyCandID := pw.PanicCandidateID
		if dummyCandID == "" {
			// panicCandidateID 미지정 시 임의의 더미 사용 (첫 번째 후보 첫 번째 더미)
			election, err := c.GetElection(ctx, electionID)
			if err != nil {
				return nil, err
			}
			if len(election.Candidates) > 0 {
				dummyCandID = election.Candidates[0]
			}
		}
		dummyIdxKey := fmt.Sprintf("DUMMY_IDX_%s_%s_0", electionID, dummyCandID)
		dummyHashBytes, err := ctx.GetStub().GetState(dummyIdxKey)
		if err != nil || dummyHashBytes == nil {
			return nil, fmt.Errorf("더미 Nullifier를 찾을 수 없습니다 (candidate: %s)", dummyCandID)
		}
		targetHash = string(dummyHashBytes)
		log.Printf("[GetMerkleProofWithPassword] Panic Mode — dummy: %s", targetHash[:16])
	} else if passwordHash != pw.NormalPWHash {
		// 두 비밀번호 모두 불일치
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
		NullifierHash: targetHash,
		CandidateID:   n.CandidateID,
		Proof:         proof,
	}, nil
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

// collectNullifierHashes CouchDB Rich Query로 선거의 모든 Nullifier Hash를 수집합니다.
func collectNullifierHashes(
	ctx contractapi.TransactionContextInterface,
	electionID string,
) ([]string, error) {
	queryString := fmt.Sprintf(
		`{"selector":{"docType":"nullifier","electionID":"%s"},"use_index":["_design/indexElection","electionIndex"]}`,
		electionID,
	)
	iter, err := ctx.GetStub().GetQueryResult(queryString)
	if err != nil {
		return nil, fmt.Errorf("CouchDB 쿼리 실패: %w", err)
	}
	defer iter.Close()

	var hashes []string
	for iter.HasNext() {
		qr, err := iter.Next()
		if err != nil {
			return nil, fmt.Errorf("결과 순회 실패: %w", err)
		}
		var n Nullifier
		if err := json.Unmarshal(qr.Value, &n); err != nil {
			return nil, fmt.Errorf("Nullifier 역직렬화 실패: %w", err)
		}
		hashes = append(hashes, n.NullifierHash)
	}
	return hashes, nil
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

	// 마스터 키 결정론적 생성
	txID := ctx.GetStub().GetTxID()
	masterKeyRaw := sha256.Sum256([]byte(txID + "::" + electionID))
	masterKey := masterKeyRaw[:]

	// 키 해시 (공개 저장 — 복원 검증용)
	keyHashRaw := sha256.Sum256(masterKey)
	keyHash := hex.EncodeToString(keyHashRaw[:])

	// 계수 시드 결정론적 생성
	coeffSeed := sha256.Sum256([]byte("COEFF::" + txID + "::" + electionID))

	// Shamir SSS: 32바이트 키 → 3개 share
	shares := shamirSplitBytes(masterKey, ShamirTotalShares, coeffSeed[:])

	// PDC에 각 share 저장
	for i, share := range shares {
		shareKey := fmt.Sprintf("KEYSHARE_%s_%d", electionID, i+1)
		if err := ctx.GetStub().PutPrivateData(VotePrivatePDC, shareKey, []byte(hex.EncodeToString(share))); err != nil {
			return nil, fmt.Errorf("share %d PDC 저장 실패: %w", i+1, err)
		}
	}

	now, err := getTxTime(ctx)
	if err != nil {
		return nil, err
	}

	status := KeySharingStatus{
		ObjectType:     "keySharingStatus",
		ElectionID:     electionID,
		Threshold:      ShamirThreshold,
		TotalShares:    ShamirTotalShares,
		SubmittedCount: 0,
		SubmittedBy:    []string{},
		IsDecrypted:    false,
		KeyHash:        keyHash,
		InitiatedAt:    now,
	}
	b, err := json.Marshal(status)
	if err != nil {
		return nil, err
	}
	if err := ctx.GetStub().PutState(statusKey, b); err != nil {
		return nil, fmt.Errorf("키 분산 상태 저장 실패: %w", err)
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

	x1, _ := strconv.Atoi(idx1Str)
	x2, _ := strconv.Atoi(idx2Str)

	reconstructed := shamirReconstructBytes(s1, s2, x1, x2)
	if reconstructed == nil {
		return fmt.Errorf("복원 실패: nil 결과")
	}

	recHashRaw := sha256.Sum256(reconstructed)
	recHash := hex.EncodeToString(recHashRaw[:])

	if recHash == status.KeyHash {
		status.IsDecrypted = true
		log.Printf("[verifyKeyReconstruction] 복원 성공 — election: %s", electionID)
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

// ============================================================
// Shamir SSS 수학 헬퍼 — Z_257 (소수 257) 위의 다항식 보간
// ============================================================

// modPow base^exp mod p (빠른 거듭제곱)
func modPow(base, exp, mod int) int {
	if mod == 1 {
		return 0
	}
	result := 1
	b := ((base % mod) + mod) % mod
	for exp > 0 {
		if exp&1 == 1 {
			result = (result * b) % mod
		}
		b = (b * b) % mod
		exp >>= 1
	}
	return result
}

// modInv Fermat의 소정리를 이용한 모듈러 역원 (p는 소수여야 함)
func modInv(a, p int) int {
	return modPow(((a%p)+p)%p, p-2, p)
}

// shamirSplitBytes 32바이트 secret을 n개 share로 분할합니다 (threshold=2).
// 각 바이트 i에 독립적인 1차 다항식 f(x) = secret[i] + coeff[i]*x (mod 257) 적용.
// share 값은 Z_257 범위(0~256)이므로 2바이트 big-endian으로 인코딩됩니다.
// coeffSeed: 결정론적 계수 생성용 시드 (chaincode 결정론성 보장)
func shamirSplitBytes(secret []byte, n int, coeffSeed []byte) [][]byte {
	// 각 share는 len(secret)*2 바이트 (각 값이 Z_257 → 2바이트 BE)
	shares := make([][]byte, n)
	for i := range shares {
		shares[i] = make([]byte, len(secret)*2)
	}

	for i := 0; i < len(secret); i++ {
		s := int(secret[i])
		r := int(coeffSeed[i%len(coeffSeed)])
		if r == 0 {
			r = 1 // 0계수는 degree-0 다항식 → threshold 무의미해짐, 방지
		}

		for shareIdx := 0; shareIdx < n; shareIdx++ {
			x := shareIdx + 1 // x = 1, 2, 3, ...
			yx := (s + r*x) % ShamirPrime
			// 2바이트 big-endian 인코딩
			shares[shareIdx][i*2]   = byte(yx >> 8)
			shares[shareIdx][i*2+1] = byte(yx & 0xFF)
		}
	}
	return shares
}

// shamirReconstructBytes 2개 share에서 Lagrange 보간으로 원본 secret을 복원합니다.
// x1, x2: share 인덱스 (1-based, 서로 다른 값)
// s1, s2: 각 share 바이트 배열 (len = keyLen*2)
func shamirReconstructBytes(s1, s2 []byte, x1, x2 int) []byte {
	if len(s1) != len(s2) || len(s1)%2 != 0 {
		return nil
	}
	keyLen := len(s1) / 2
	result := make([]byte, keyLen)

	p := ShamirPrime
	// Lagrange 보간 at x=0:
	// f(0) = y1 * (0-x2)/(x1-x2) + y2 * (0-x1)/(x2-x1)  (mod p)
	invDen1 := modInv(x1-x2, p)
	invDen2 := modInv(x2-x1, p)

	for i := 0; i < keyLen; i++ {
		y1 := int(s1[i*2])<<8 | int(s1[i*2+1])
		y2 := int(s2[i*2])<<8 | int(s2[i*2+1])

		term1 := ((p-x2)%p * y1 % p * invDen1) % p
		term2 := ((p-x1)%p * y2 % p * invDen2) % p
		reconstructed := (term1 + term2) % p
		result[i] = byte(reconstructed)
	}
	return result
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
			CCID:    ccID,
			Address: serverAddr,
			CC:      cc,
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
