/**
 * @file CompletionService.ts
 * @brief 다중 언어 지원 자동완성 서비스 핵심 로직
 *
 * 언어별로 분리된 Native Parser Addon, JSON DB, TokenMapper를 조율
 * 1. Native C++ Parser (Addon): 커서 위치의 파싱 상태(State ID) 분석
 * 2. JSON Database: 파싱 상태에 따른 구조적 후보군(Structural Candidates) 조회
 * 3. OpenAI LLM: 구조적 후보를 바탕으로 코드 생성
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

// 언어별 리소스 설정
export interface LanguageConfig {
  addonName: string;         // 빌드된 addon 파일명 (확장자 제외), e.g., "sb_parser_addon"
  candidatesFile: string;    // resources/<languageId>/ 안의 DB 파일명, e.g., "candidates.json"
  tokenMapFile: string;      // resources/<languageId>/ 안의 매핑 파일명, e.g., "token_mapping.json"
  displayName: string;       // LLM 프롬프트에 사용할 언어 이름, e.g., "Small Basic"
}

export class CompletionService {
    private parserAddon: any;
    private fullText: string;
    private byteOffset: number;
    private languageId: string;
    private config: LanguageConfig;
    private extensionPath: string;
    private dataReceivedCallback: ((data: any) => void) | null = null;

    // 언어 ID를 키로 하는 정적 캐시 (여러 인스턴스 간 DB 공유)
    private static dbCache: Map<string, CandidateDB> = new Map();
    private static mapperCache: Map<string, TokenMapper> = new Map();

    private openai: OpenAI | undefined;

    // =========================================================================
    // [생성자] 서비스 초기화 및 리소스 로딩
    // =========================================================================
    constructor(
        extensionPath: string,
        languageId: string,
        config: LanguageConfig,
        fullText: string,
        byteOffset: number
    ) {
        this.fullText = fullText;
        this.byteOffset = byteOffset;
        this.languageId = languageId;
        this.config = config;
        this.extensionPath = extensionPath;

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
        } else {
            this.openai = new OpenAI({ apiKey });
        }

        // TokenMapper 로딩 (언어별 캐시)
        if (!CompletionService.mapperCache.has(languageId)) {
            const mappingPath = path.join(extensionPath, 'resources', languageId, config.tokenMapFile);
            if (fs.existsSync(mappingPath)) {
                try {
                    CompletionService.mapperCache.set(languageId, new TokenMapper(mappingPath));
                    console.log(`[Info] TokenMapper loaded for "${languageId}"`);
                } catch (e) {
                    console.error(`[Error] Failed to parse token_mapping for "${languageId}"`, e);
                }
            } else {
                console.warn(`[Warning] token_mapping not found: ${mappingPath}`);
            }
        }

        // Native C++ Addon 로딩
        const addonPath = path.join(extensionPath, 'build', 'Release', `${config.addonName}.node`);
        try {
            this.parserAddon = require(addonPath);
            console.log(`[Info] Addon loaded: ${config.addonName}`);
        } catch (e) {
            console.error(`[Error] Addon 로딩 실패! 경로: ${addonPath}`, e);
            vscode.window.showErrorMessage(`파서 모듈을 찾을 수 없습니다: ${config.addonName}.node`);
        }

        // 구조적 후보 DB 로딩 (언어별 캐시)
        if (!CompletionService.dbCache.has(languageId)) {
            this.loadCandidateDB(extensionPath);
        }
    }

    // =========================================================================
    // [DB] Database Management
    // =========================================================================
    private loadCandidateDB(extensionPath: string) {
        try {
            const jsonPath = path.join(extensionPath, 'resources', this.languageId, this.config.candidatesFile);
            console.log(`[Info] Loading Candidate DB from: ${jsonPath}`);
            if (fs.existsSync(jsonPath)) {
                const rawData = fs.readFileSync(jsonPath, 'utf8');
                CompletionService.dbCache.set(this.languageId, JSON.parse(rawData));
                console.log(`[Info] Candidate DB loaded for "${this.languageId}"`);
            } else {
                console.error(`[Error] Candidate JSON not found at: ${jsonPath}`);
                vscode.window.showErrorMessage(`자동완성 데이터 파일을 찾을 수 없습니다: ${jsonPath}`);
            }
        } catch (e) {
            console.error("[Error] Failed to load Candidate DB:", e);
        }
    }

    // * 파서 상태들(states)에 매핑되는 구조적 후보들을 조회하고 합침
    // * 여러 State에서 공통적으로 등장하는 후보는 빈도수(value)를 합산
    // * 최종적으로 빈도수 높은 순서대로 정렬하여 반환
    public lookupDB(states: number[]): { finalResult: any[], stateLines: string[] } {
        const db = CompletionService.dbCache.get(this.languageId);
        const mapper = CompletionService.mapperCache.get(this.languageId);
        const stateLines: string[] = [];

        if (!db) {
            console.warn(`[Warning] DB is not loaded for "${this.languageId}".`);
            return { finalResult: [], stateLines };
        }

        const mergedMap = new Map<string, any>();

        for (const state of states) {
            const stateKey = state.toString();
            if (db[stateKey]) {
                const candidates = db[stateKey];
                const msg = `State ${state}: Found ${candidates.length} candidates`;
                console.log(msg);
                stateLines.push(msg);
                candidates.forEach((item) => {
                    if (mergedMap.has(item.key)) {
                        mergedMap.get(item.key).value += item.value;
                    } else {
                        mergedMap.set(item.key, { ...item });
                    }
                });
            } else {
                const msg = `No state ${state} in DB`;
                console.log(msg);
                stateLines.push(msg);
            }
        }

        const result = Array.from(mergedMap.values());
        result.sort((a, b) => b.value - a.value);

        const finalResult = result.map((item, index) => {
            const readableKey = mapper
                ? this.convertKeyToReadable(item.key, mapper)
                : item.key;
            return {
                key: readableKey,
                value: item.value,
                sortText: (index + 1).toString().padStart(3, "0")
            };
        });

        if (finalResult.length > 0) {
            console.log("[lookupDB] Final Merged Result:", JSON.stringify(finalResult, null, 2));
        } else {
            console.log("[lookupDB] No candidates found.");
        }
        return { finalResult, stateLines };
    }

    // helper
    private convertKeyToReadable(rawKeyString: string, mapper: TokenMapper): string {
        try {
            // DB key는 공백으로 구분된 토큰 나열 형식 ("ID = Expr", "[ expression ]" 등)
            // 각 토큰을 공백으로 분리 후 token_mapping으로 변환
            const tokens = rawKeyString.split(" ").filter(t => t.length > 0);
            const convertedTokens = tokens.map(token => mapper.getHumanReadableName(token));
            return convertedTokens.join(" ");
        } catch (e) {
            return rawKeyString;
        }
    }

    public onDataReceived(callback: (data: any) => void) {
        this.dataReceivedCallback = callback;
    }

    // =========================================================================
    // [Core Logic 1] Structural Candidates
    // =========================================================================
    public getStructCandidates() {
        try {
            const mode = vscode.workspace.getConfiguration('completion').get<number>('parsingMode', 0);
            const headerLine = `[${this.config.displayName}] Requesting Parse: byteOffset ${this.byteOffset}, mode=${mode}`;
            console.log(headerLine);
            const states = this.parserAddon.getConversionResult(this.fullText, this.byteOffset, mode);
            const pathLine = `Parsed State Path: ${JSON.stringify(states)}`;
            console.log(pathLine);

            const { finalResult, stateLines } = this.lookupDB(states);

            // ============================================================
            // [Debug Dump] Ctrl+Space 결과를 임시 파일로 저장
            // - last_completion_dump.txt
            // - last_completion_prompt.txt
            // 두 파일 모두 매 호출마다 덮어쓰기. .gitignore 등록됨.
            // ============================================================

            // --- (1) last_completion_dump.txt ---
            const dumpLines = [
                headerLine,
                pathLine,
                ...stateLines,
                "[lookupDB] Final Merged Result:",
                ...finalResult.map(item => `${item.sortText} : ${item.key}`)
            ];
            const dumpPath = path.join(this.extensionPath, "last_completion_dump.txt");
            try {
                fs.writeFileSync(dumpPath, dumpLines.join("\n") + "\n", "utf8");
            } catch (e) {
                console.error("[Dump] Failed to write dump file:", e);
            }

            // --- (2) last_completion_prompt.txt ---
            // byteOffset은 UTF-8 바이트 단위이므로 Buffer로 자른 뒤 다시 문자열로 디코드
            const sourceUpToCursor = Buffer.from(this.fullText, "utf8")
                .slice(0, this.byteOffset)
                .toString("utf8");
            const promptLines = [
                `당신은 ${this.config.displayName} 문법 전문가입니다.`,
                `아래는 특정 커서 위치에서의 자동완성 구조 후보 목록입니다.`,
                ``,
                `[커서 직전까지의 소스 코드 (커서 위치는 <<<커서>>>로 표시)]`,
                sourceUpToCursor + "<<<커서>>>",
                ``,
                `[컨버전 요청 byteOffset] ${this.byteOffset}`,
                `[파서 State Path] ${JSON.stringify(states)}`,
                `[State별 DB 조회 결과]`,
                ...stateLines,
                ``,
                `[후보 목록 (sortText : key)]`,
                ...finalResult.map(item => `${item.sortText} : ${item.key}`),
                ``,
                `[작업]`,
                `각 후보가 커서 위치 직후에 문법적으로 나타날 수 있는지 판정하세요.`,
                ``,
                `[중요 판정 기준 - 반드시 숙지할 것]`,
                `1. 순수한 "파서(Parser)의 구문 분석(Syntax/AST) 트리" 기준으로만 판정하세요. 컴파일/런타임 레벨의 제약은 무시합니다.`,
                `2. 파서의 구문 규칙은 식별자(Identifier)의 구체적인 문자열 이름(예: 특정 특수 메서드명, 내장 함수명 등)에 따라 분기되지 않음을 명심하세요. 해당 언어의 파싱 단계에서 구조적으로 허용되는 형태라면 모두 valid로 간주합니다.`,
                ``,
                `출력 형식 (각 줄에 하나):`,
                `  sortText | 판정 (valid|suspect|unknown) | 한 줄 사유`,
                `- valid → 사유 생략 가능`,
                `- suspect / unknown → 사유 필수`,
                `- 확신이 없으면 "unknown"으로 표시. "suspect"는 근거를 댈 수 있을 때만.`
            ];
            const promptPath = path.join(this.extensionPath, "last_completion_prompt.txt");
            try {
                fs.writeFileSync(promptPath, promptLines.join("\n") + "\n", "utf8");
            } catch (e) {
                console.error("[Prompt] Failed to write prompt file:", e);
            }

            // ============================================================
            // [Debug Dump End]
            // ============================================================

            if (this.dataReceivedCallback) {
                this.dataReceivedCallback(finalResult);
            }
        } catch (e) {
            console.error("Parser Error:", e);
        }
    }

    // =========================================================================
    // [Core Logic 2] Textual Candidates (LLM)
    // =========================================================================
    public async getTextCandidate(structCandidate: string, fullContext: string): Promise<string> {
        try {
            const prompt = generateCompletionPrompt(fullContext, structCandidate, this.config.displayName);
            console.log(`[LLM Prompt] ${prompt}`);

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
            return "";
        }
    }
}
