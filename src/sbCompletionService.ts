/**
 * @file SbCompletionService.ts
 * @brief Small Basic 자동완성 서비스의 핵심 로직을 담당하는 클래스
 * * 이 클래스는 다음 3가지 핵심 모듈을 조율합니다:
 * 1. Native C++ Parser (Addon): 현재 커서 위치의 파싱 상태(State ID)를 분석
 * 2. JSON Database: 파싱 상태에 따른 구조적 후보군(Structual Candidates) 조회
 * 3. OpenAI LLM: 구조적 후보를 바탕으로 텍스트 후보(Textual Candidate) 생성
 */

import * as vscode from "vscode";
import * as fs from "fs";
import OpenAI from "openai";
import * as path from "path";
import { TokenMapper } from "./mapLoader";
import { SYSTEM_ROLE, generateCompletionPrompt } from "./prompts";

// 구조적 후보 데이터 인터페이스 (DB 저장 형태)
interface CandidateData {
  key: string;    // 예: "[ID, =, STR]"
  value: number;  // 빈도수
}

// 상태 ID를 키로 하는 후보군 DB 인터페이스
interface CandidateDB {
  [stateId: string]: CandidateData[];
}

export class SbCompletionService {
    private parserAddon: any;
    private fullText: string;
    private row: number;
    private col: number;
    private dataReceivedCallback: ((data: any) => void) | null = null;
    
    // 모든 인스턴스가 공유하는 정적 DB
    private static candidateDB: CandidateDB | null = null;
    private static tokenMapper: TokenMapper | null = null;
    private openai: OpenAI | undefined;

    // =========================================================================
    // [생성자] 서비스 초기화 및 리소스 로딩
    // =========================================================================
    // * extensionPath 확장 프로그램의 루트 경로 (리소스 파일 접근용)
    // * fullText 에디터의 전체 소스 코드
    // * row, col 커서 위치
    constructor(extensionPath: string, fullText: string, row: number, col: number) {
        this.fullText = fullText;
        this.row = row;
        this.col = col;

        // OpenAI API Key 로딩 (secrets.json)
        let apiKey = "";
        try {
            const secretPath = path.join(extensionPath, 'secrets.json');
            if (fs.existsSync(secretPath)) {
                const secretData = fs.readFileSync(secretPath, 'utf8');
                const secrets = JSON.parse(secretData);
                apiKey = secrets.apiKey;
                console.log("[Info] Loaded API Key from secrets.json");
            } else {
                console.error(`[Error] secrets.json not found at: ${secretPath}`);
            }
        } catch (err) {
            console.error("[Error] Failed to read secrets.json:", err);
        }
        if (!apiKey) {
            vscode.window.showErrorMessage("API Key가 없습니다. 프로젝트 루트에 secrets.json을 생성하고 키를 넣어주세요.");
            console.error("[Error] OpenAI API Key is missing.");
        } else {
            this.openai = new OpenAI({
                apiKey: apiKey, 
            });
        }

        // token mapper 로딩
        if (!SbCompletionService.tokenMapper) {
            const mappingPath = path.join(__dirname, "..", "token_mapping.json");
            if (fs.existsSync(mappingPath)) {
                try {
                    SbCompletionService.tokenMapper = new TokenMapper(mappingPath);
                    console.log("[Info] TokenMapper loaded successfully.");
                } catch (e) {
                    console.error("[Error] Failed to parse token_mapping.json", e);
                }
            } else {
                console.warn(`[Warning] token_mapping.json not found at: ${mappingPath}`);
            }
        }

        // Native C++ Addon 로딩
        const addonPath = path.join(extensionPath, 'build', 'Release', 'sb_parser_addon.node');
        try {
            // .node 모듈은 동적으로 require
            this.parserAddon = require(addonPath);
        } catch (e) {
            console.error(`[Error] Addon 로딩 실패! 경로: ${addonPath}`, e);
            vscode.window.showErrorMessage("파서 모듈을 찾을 수 없습니다.");
        }

        // 구조적 후보 DB 로딩
        if (!SbCompletionService.candidateDB) {
          this.loadCandidateDB(extensionPath);
        }
    }
    
    // =========================================================================
    // [DB] Database Management
    // =========================================================================  
    // * 로컬 JSON 파일에서 구조적 후보 데이터를 로드
    private loadCandidateDB(extensionPath: string) {
      try {
        const jsonPath = path.join(extensionPath, 'src', 'smallbasic_candidates2.json');
        console.log(`[Info] Loading Candidate DB from: ${jsonPath}`);
        
        if (fs.existsSync(jsonPath)) {
              const rawData = fs.readFileSync(jsonPath, 'utf8');
              SbCompletionService.candidateDB = JSON.parse(rawData);
              console.log("[Info] Candidate DB loaded successfully.");
        } else {
              console.error(`[Error] Candidate JSON not found at: ${jsonPath}`);
              vscode.window.showErrorMessage("자동완성 데이터 파일을 찾을 수 없습니다.");
        }
      } catch (e) {
          console.error("[Error] Failed to load Candidate DB:", e);
      }
    }

    // * 파서 상태들(states)에 매핑되는 구조적 후보들을 조회하고 합침
    // * 여러 State에서 공통적으로 등장하는 후보는 빈도수(Value)를 합산
    // * 최종적으로 빈도수가 높은 순서대로 정렬하여 반환
    public lookupDB(states: number[]) {
        const db = SbCompletionService.candidateDB;
        const mapper = SbCompletionService.tokenMapper;

        if (!db) {
            console.warn("[Warning] DB is not loaded yet.");
            return [];
        }

        // 1. 중복 제거 및 빈도수 합산을 위한 Map
        // Key: 후보 문자열 (예: "[ID, =, Expr]")
        // Value: 후보 객체 (빈도수가 누적됨)
        const mergedMap = new Map<string, any>();

        for (const state of states) {
            const stateKey = state.toString();

            if (db[stateKey]) {
                const candidates = db[stateKey];
                // 로그
                const patterns = candidates.map(c => c.key);
                console.log(`State ${state}: Found ${candidates.length} candidates -> ${JSON.stringify(patterns)}`);

                candidates.forEach((item) => {
                    if (mergedMap.has(item.key)) {
                        // [Case A] 이미 존재하는 후보 -> 빈도수 합산
                        const existing = mergedMap.get(item.key);
                        existing.value += item.value;
                    } else {
                        // [Case B] 새로운 후보 -> 맵에 등록
                        // 원본 DB 훼손 방지를 위해 얕은 복사({...item}) 사용
                        mergedMap.set(item.key, { ...item });
                    }
                });
            }
            else {
                // 로그
                console.log(`No state ${state} in DB`);
            }
        }

        // 2. Map을 배열로 변환
        const result = Array.from(mergedMap.values());

        // 3. 빈도수(Value) 내림차순 정렬
        result.sort((a, b) => b.value - a.value);

        // 4. sortText 재할당
        // VS Code는 sortText 문자열 순서대로 UI에 표시하므로, 
        // 정렬이 끝난 후 최종 순서대로 "001", "002"를 매겨야 함.
        const finalResult = result.map((item, index) => {

            // mapper가 있으면 변환, 없으면 원본
            const readableKey = mapper 
                ? this.convertKeyToReadable(item.key, mapper) 
                : item.key;

            return {
                key: readableKey, // item.key,
                value: item.value,
                sortText: (index + 1).toString().padStart(3, "0") // "001", "002"...
            };
        });

        if (finalResult.length > 0) {
            console.log("[lookupDB] Final Merged Result");
            console.log(JSON.stringify(finalResult, null, 2)); 
        } else {
            console.log("[lookupDB] Final Result: No candidates found.");
        }
        return finalResult;
    }

    // helper
    private convertKeyToReadable(rawKeyString: string, mapper: TokenMapper): string {
        try {
            const content = rawKeyString.replace(/^\[|\]$/g, "");
            const tokens = content.split(",").map(t => t.trim());
            const convertedTokens = tokens.map(token => mapper.getHumanReadableName(token));
            return `[${convertedTokens.join(", ")}]`;
        } catch (e) {
            return rawKeyString;
        }
    }

    // * 비동기 데이터 처리를 위한 콜백 등록
    // * 구조적 후보 조회가 완료되면 호출된다
    public onDataReceived(callback: (data: any) => void) {
        this.dataReceivedCallback = callback;
    }

    // =========================================================================
    // [Core Logic 1] Structural Candidates
    // =========================================================================
    // * C++ Addon을 통해 컨버전 결과를 얻음
    // * 컨버전 결과의 모든 State에 대해 DB를 조회
    // * 조회된 구조적 후보 합집합, 중복된 후보는 빈도수 합산
    public getStructCandidates() {
        try {
            console.log(`Requesting Parse: Row ${this.row}, Col ${this.col}`);

            // C++ Addon 호출 (number[] 배열을 반환)
            // 예: [51, 29, 65, 240]
            const states = this.parserAddon.getConversionResult(this.fullText, this.row, this.col);
            console.log("Parsed State Path:", JSON.stringify(states));

            // DB 조회 (lookupDB가 알아서 합치고 정렬)
            const structCandidates = this.lookupDB(states);

            // 결과 전달 (extension.ts로 콜백)
            if (this.dataReceivedCallback) {
                this.dataReceivedCallback(structCandidates);
            }
        } catch (e) {
            console.error("Parser Error:", e);
        }
    }

    // =========================================================================
    // [Core Logic 2] Textual Candidates (LLM)
    // =========================================================================
    // * LLM을 이용한 실제 코드 생성
    // * 구조적 후보와 문맥(Context)을 조합하여 OpenAI에 코드를 요청
    // * LLM이 생성한 코드 문자열를 리턴
    public async getTextCandidate(
      structCandidate: string,
      fullContext: string
    ): Promise<string> {

        try {
            // 1. 프롬프트 구성 (prompts.ts)
            const prompt = generateCompletionPrompt(fullContext, structCandidate);
            console.log(`[LLM Prompt] ${prompt}`);

            // 2. OpenAI API 호출
            if (!this.openai) { return ""; }
            
            const chat_completion = await this.openai.chat.completions.create({
                model: "gpt-3.5-turbo",
                messages: [
                    { role: "system", content: SYSTEM_ROLE },
                    { role: "user", content: prompt }
                ]
            });

            const response = chat_completion.choices[0].message.content?.trim() || "";
            console.log(`[LLM Response] ${response}`);

            return response;
          
        } catch (error) {
            console.error("[LLM Error]", error);
            // 에러 발생 시 Extension이 멈추지 않도록 빈 문자열 반환
            return "";
        }
    }
}