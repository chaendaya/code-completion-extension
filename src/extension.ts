// extension.ts
// Small Basic VS Code 확장 프로그램의 메인 진입점
// Step 1. [Ctrl+Space] -> 'extension.promptkey': 현재 커서 위치를 파싱하여 '구조적 후보'를 도출 (C++ Addon)
// Step 2. [Callback]   -> 'extension.subpromptkey': 도출된 구조를 바탕으로 LLM에게 코드를 요청하고 자동완성 목록에 표시
import * as vscode from "vscode";
import { SbCompletionService } from "./sbCompletionService";

let CompletionProvider: any;
let candidatesData: StructuralCandidate[];
let currentCompletionService: SbCompletionService | undefined;

type StructuralCandidate = {
  key: string;      // 예: "[ID, =, STR]"
  value: number;    // 빈도수
  sortText: string; // 정렬 순위
};

// 확장 프로그램 활성화 함수 (VS Code가 실행될 때 최초 1회 호출)
export function activate(context: vscode.ExtensionContext) {
  console.log("Running the VSC Extension");

  // =============================================================================
  // [Helper Functions] 전처리 및 유틸리티
  // =============================================================================
  // * 패턴 가독성 변환 (Humanize)
  // * LLM이 이해하기 쉬운 자연어 힌트로 변환
  // * 예: ID = STR -> Identifier = String
  // function humanizePattern(pattern: string): string {
  //   return pattern
  //     .replace(/\bID\b/g, "Identifier")
  //     .replace(/\bSTR\b/g, "String")
  //     .replace(/\bNUM\b/g, "Number")
  //     .replace(/\bExpr\b/g, "Expression")
  //     .replace(/\bCR\b/g, "\n") // 줄바꿈 명시
  //     .trim();
  // }

  /**
   * [Helper 2] 코드 정규화 (Normalization)
   * 사용자의 입력 스타일(띄어쓰기 등)과 AI의 출력 스타일을 비교하기 위해
   * 공백을 제거하고 표준 형태로 만든다.
   */
  function normalizeCode(text: string): string {
    return text
      .replace(/\s*\(\s*/g, "(")
      .replace(/\s*\)\s*/g, ")")
      .replace(/\s*=\s*/g, "=")
      .replace(/\s*>\s*/g, ">")
      .replace(/\s*<\s*/g, "<")
      .trim();
  }

  /**
   * [Helper 3] LLM 응답 후처리 (Refinement)
   * AI가 생성한 코드에서 중복된 접두사나 의미 없는 반복을 제거한다.
   * @param responseText LLM이 생성한 원본 응답
   * @param normalizedFullContext 비교용 전체 문맥 (정규화됨)
   * @param normalizedLineContext 비교용 현재 라인 (정규화됨)
   * @param structuralHint AI에게 주었던 힌트 (단순 반복 체크용)
   */
  function refineLLMResponse(
    responseText: string,
    normalizedFullContext: string,
    normalizedLineContext: string,
    structuralHint: string
  ): string | null {
      // 1. 응답 정규화
      const normalizedResponse = normalizeCode(responseText);

      // 2. 힌트 단순 반복 체크 (AI가 힌트를 그대로 뱉는 경우 필터링)
      const normalizedHint = structuralHint.replace(/\s/g, "");
      if (normalizedResponse.replace(/\s/g, "") === normalizedHint) {
          console.log("-> Skipped: LLM just repeated the hint.");
          return null;
      }

      // 3. 접두어 중복 제거 로직
      let finalText = responseText;

      // case 1: 전체 문맥과 겹치는 경우
      if (normalizedResponse.includes(normalizedFullContext)) {
          finalText = normalizedResponse.replace(normalizedFullContext, '');
      }
      // case 2: 현재 라인과 겹치는 경우
      else if (normalizedResponse.includes(normalizedLineContext)) {
          finalText = normalizedResponse.replace(normalizedLineContext, '');
      }

      // 4. 최종 포맷팅 (연산자 공백 추가 등)
      finalText = finalText
          .replace(/=/g, " = ")
          .replace(/</g, " < ")
          .replace(/>/g, " > ")
          .trim();

      return finalText;
  }

  // =============================================================================
  // [Step 1.5] 구조 후보만 VS Code 자동완성으로 띄우기 ("extension.previewStructures")
  // =============================================================================
  // * 실행 시점: 파서가 구조적 후보를 찾은 직후 (Step 1의 Callback)
  // * 동작: 상위 20개 구조 후보를 자동완성 목록에 표시 (LLM 호출 없음)
  const previewStructuresCommand = vscode.commands.registerCommand(
    "extension.previewStructures",
    () => {
      // 1. 기존 provider 정리
      if (CompletionProvider) {
        try {
          const disposable = vscode.Disposable.from(CompletionProvider);
          disposable.dispose();
        } catch (e) {
          console.log("[Info] No previous CompletionProvider to dispose.", e);
        }
      }

      // 2. 새로운 자동완성 공급자 등록
      CompletionProvider = vscode.languages.registerCompletionItemProvider(
        // vscode.languages.registerCompletionItemProvider 
        // VS Code가 제공하는 자동완성 시스템에 커스텀 로직 연결
        
        // arg1: selector 작동할 언어
        ["smallbasic"],

        // arg2: provider 공급자
        {
          async provideCompletionItems(
            document: vscode.TextDocument,
            position: vscode.Position
          ): Promise<vscode.CompletionItem[]> {
            const completionItems: vscode.CompletionItem[] = [];

            // candidatesData가 없으면 더미 아이템 반환
            // (빈 배열을 반환하면 VS Code 기본 단어 자동완성이 대신 채우므로,
            //  더미 아이템으로 팝업을 점유하여 식별자 목록을 억제)
            const lineContext = document.lineAt(position).text.slice(0, position.character);
            if (!candidatesData || candidatesData.length === 0) {
              const placeholder = new vscode.CompletionItem("(No candidates found)");
              placeholder.insertText = new vscode.SnippetString("");
              placeholder.filterText = lineContext;
              placeholder.sortText = "000";
              return [placeholder];
            }
            
            // candidatesData가 있으면 VS Code UI 객체화

            // [트릭] 추천하는 구조를 무조건 보여줌
            // VS Code는 자동완성 목록을 띄울 때, 사용자가 지금까지 타이핑한 단어(Prefix)와 추천 목록의 라벨(Label)을 비교
            // 구조 후보 목록이 즉시 제거되는 VS Code 기본 동작을 속이기 위함

            // 상위 20개 출력
            const maxScroll = 20;
            const topCandidates = candidatesData.slice(0, maxScroll);

            for (const { key, value, sortText } of topCandidates) {
              const cleanKey = key
                .replace(/^\[|\]$/g, "")
                .replace(/,/g, " ")
                .replace(/\s+/g, " ")
                .trim();

              // const structCandidate = humanizePattern(cleanKey); // 예: "Identifier = String"

              const item = new vscode.CompletionItem(cleanKey);  // 라벨 설정
              item.sortText = sortText; // 빈도 기반 정렬 유지
              item.filterText = lineContext;  // 구조 후보 목록 유지
              item.insertText = new vscode.SnippetString(""); // 입력 방지 (“구조 후보 표시” 목적)
              item.documentation = new vscode.MarkdownString()  // 우측 설명
                .appendMarkdown(`**Structure Raw:** \`${cleanKey}\`\n\n`)
                .appendMarkdown(`**Frequency:** ${value}\n\n`);

              completionItems.push(item);
            }
            return completionItems;
          }
        }
      );

      // 3. 자동완성 창 띄우기
      vscode.commands.executeCommand("editor.action.triggerSuggest");
    }
  );

  // =============================================================================
  // [Step 2] LLM 기반 텍스트 생성 및 자동완성 UI 표시 ("extension.generateCode")
  // =============================================================================
  // * 실행 시점: 파서가 구조적 후보를 찾은 직후 (Step 1의 Callback)
  const generateCodeCommand = vscode.commands.registerCommand(
    "extension.generateCode",
    () => {
      // 1. 기존 provider 정리
      if (CompletionProvider) {
        try {
          const disposable = vscode.Disposable.from(CompletionProvider);
          disposable.dispose();
        } catch (e) {
          console.log("[Info] No previous CompletionProvider to dispose.", e);
        }
      }

      // 2. 새로운 자동완성 공급자 등록
      CompletionProvider = vscode.languages.registerCompletionItemProvider(
        // arg1: selector 작동할 언어
        ["smallbasic"],

        // arg2: provider 공급자
        {
          async provideCompletionItems(
            document: vscode.TextDocument,
            position: vscode.Position
          ): Promise<vscode.CompletionItem[]> {
            const completionItems: vscode.CompletionItem[] = [];

            // 데이터 유효성 검사
            if (!candidatesData || candidatesData.length === 0) {
              return completionItems;
            }

            // VS Code UI 객체화

            // 문맥 수집
            // [트릭] 필터링 방지용: 현재 라인의 텍스트를 filterText로 사용
            const lineContext = document.lineAt(position).text.slice(0, position.character);
            const normalizedLineContext = normalizeCode(lineContext);

            // LLM 프롬프트용 전체 코드
            const fullContext = document.getText(new vscode.Range(new vscode.Position(0, 0), position));
            const normalizedFullContext = normalizeCode(fullContext);

            // 상위 3개만 LLM 요청
            const maxScroll = 3;
            const topCandidates = candidatesData.slice(0, maxScroll);

            // 구조적 후보 순회 및 LLM 요청
            for (const { key, value, sortText } of topCandidates) {
              // 프롬프트 준비
              // const structCandidate = humanizePattern(key); // 예: "Identifier = String"
              const cleanKey = key
                .replace(/^\[|\]$/g, "")
                .replace(/,/g, " ")
                .replace(/\s+/g, " ")
                .trim();

              console.log(`[Processing LLM Candidate] Hint: ${cleanKey}`);

              // LLM 코드 생성 요청
              let responseText = "";
              if (currentCompletionService) {
                // 비동기 대기 (순차 처리)
                responseText = await currentCompletionService.getTextCandidate(cleanKey, fullContext);
              }

              // 응답 정제 및 유효성 검사
              if (!responseText) continue;
              const finalText = refineLLMResponse(
                responseText,
                normalizedFullContext,
                normalizedLineContext,
                cleanKey
              );
              if (!finalText) continue; // 정제 후 남는 게 없으면 스킵
              console.log(`[Final Code Generated] ${finalText}`);

              // UI 아이템 생성
              // insertText에 실제 코드를 넣어 엔터 시 입력되게 함
              const item = new vscode.CompletionItem(finalText); // 라벨: 실제 코드
              item.sortText = sortText;                          // 정렬: 빈도수 유지
              item.filterText = lineContext;                     // 필터링 방지 트릭
              item.insertText = new vscode.SnippetString(finalText); // 실제 입력값

              // 우측 설명창 (구조 정보 + 힌트)
              item.documentation = new vscode.MarkdownString()
                .appendMarkdown(`**Generated Code:** \`${finalText}\`\n\n`)
                .appendMarkdown(`**Based on Structure:** \`${cleanKey}\`\n\n`)
                .appendMarkdown(`**Frequency:** ${value}`);

              completionItems.push(item);
            }
            return completionItems;
          }
        }
      );
      // 자동완성 창 띄우기
      vscode.commands.executeCommand("editor.action.triggerSuggest");
    }
  );

  // =============================================================================
  // [Step 1] 진입점: 파싱 요청 및 워크플로우 시작 ("extension.triggerParsing")
  // =============================================================================
  // * 실행 시점: Ctrl+Space 를 눌렀을 때
  const triggerParsingCommand = vscode.commands.registerCommand(
      "extension.triggerParsing",
      () => {
          const activeEditor = vscode.window.activeTextEditor;

          if (activeEditor) {
              const document = activeEditor.document;

              // 1. 현재 에디터 상태 수집
              const cursorPosition = activeEditor.selection.active;
              const fullText = document.getText();  // 전체 소스 코드
              const row = cursorPosition.line + 1;  // 커서 행
              const col = cursorPosition.character + 1; // 1-based
            
              // 2. Service 인스턴스 생성 (파서 및 LLM 클라이언트 초기화)
              const completionService = new SbCompletionService(
                context.extensionPath,
                fullText, 
                row,
                col
              );
              currentCompletionService = completionService;

              // 3. 콜백 설정: 파싱이 완료되면 실행될 로직 정의
              completionService.onDataReceived((data: any) => {
                  candidatesData = data;  // 전역 변수에 구조 후보 데이터 저장
                  
                  // 5. Step 2 (자동완성 로직 트리거) 실행
                  vscode.commands.executeCommand("extension.previewStructures"); // previewStructures generateCode
              });

              // 4. 파싱 시작 (구조적 후보 도출 요청)
              completionService.getStructCandidates();

          } else {
              console.log("There are currently no open editors.");
          }
      }
  );  

  // 확장 프로그램에 명령어 등록
  context.subscriptions.push(
    generateCodeCommand,
    previewStructuresCommand,
    triggerParsingCommand
  );
}

// 확장 비활성화 시 호출
export function deactivate() {}
