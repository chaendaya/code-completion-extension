// extension.ts
// VS Code 확장 프로그램의 메인 진입점 (다중 언어 지원)
// Step 1. [Ctrl+Space] -> 'extension.triggerParsing': 현재 커서 위치를 파싱하여 '구조적 후보'를 도출 (C++ Addon)
// Step 2. [Callback]   -> 'extension.previewStructures' | 'extension.generateCode': 후보를 자동완성 목록에 표시
import * as vscode from "vscode";
import { CompletionService, LanguageConfig } from "./CompletionService";

// =============================================================================
// [언어 설정 맵] 지원 언어별 리소스 경로 및 표시 이름 정의
// =============================================================================
const LANGUAGE_CONFIGS: Record<string, LanguageConfig> = {
  "smallbasic": {
    addonName: "sb_parser_addon",
    candidatesFile: "candidates.json",
    tokenMapFile: "token_mapping.json",
    displayName: "Small Basic",
  },
  "c": {
    addonName: "c_parser_addon",
    candidatesFile: "candidates.json",
    tokenMapFile: "token_mapping.json",
    displayName: "C",
  },
};

// 지원 언어 ID 목록 (CompletionProvider 셀렉터에 사용)
const SUPPORTED_LANGUAGES = Object.keys(LANGUAGE_CONFIGS);

let CompletionProvider: any;
let candidatesData: StructuralCandidate[];
let currentCompletionService: CompletionService | undefined;

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
   * [Helper] LLM 응답 후처리 (Refinement)
   * AI가 생성한 코드에서 중복된 접두사나 의미 없는 반복을 제거한다.
   */
  function refineLLMResponse(
    responseText: string,
    normalizedFullContext: string,
    normalizedLineContext: string,
    structuralHint: string
  ): string | null {
      const normalizedResponse = normalizeCode(responseText);

      // 힌트 단순 반복 체크
      const normalizedHint = structuralHint.replace(/\s/g, "");
      if (normalizedResponse.replace(/\s/g, "") === normalizedHint) {
          console.log("-> Skipped: LLM just repeated the hint.");
          return null;
      }

      // 접두어 중복 제거 로직
      let finalText = responseText;
      if (normalizedResponse.includes(normalizedFullContext)) {
          finalText = normalizedResponse.replace(normalizedFullContext, '');
      } else if (normalizedResponse.includes(normalizedLineContext)) {
          finalText = normalizedResponse.replace(normalizedLineContext, '');
      }

      // 최종 포맷팅
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
  const previewStructuresCommand = vscode.commands.registerCommand(
    "extension.previewStructures",
    () => {
      if (CompletionProvider) {
        try {
          vscode.Disposable.from(CompletionProvider).dispose();
        } catch (e) {
          console.log("[Info] No previous CompletionProvider to dispose.", e);
        }
      }

      CompletionProvider = vscode.languages.registerCompletionItemProvider(
        SUPPORTED_LANGUAGES,
        {
          async provideCompletionItems(
            document: vscode.TextDocument,
            position: vscode.Position
          ): Promise<vscode.CompletionItem[]> {
            const completionItems: vscode.CompletionItem[] = [];
            const lineContext = document.lineAt(position).text.slice(0, position.character);

            if (!candidatesData || candidatesData.length === 0) {
              const placeholder = new vscode.CompletionItem("(No candidates found)");
              placeholder.insertText = new vscode.SnippetString("");
              placeholder.filterText = lineContext;
              placeholder.sortText = "000";
              return [placeholder];
            }

            const topCandidates = candidatesData.slice(0, 20);

            for (const { key, value, sortText } of topCandidates) {
              const cleanKey = key
                .replace(/^\[|\]$/g, "")
                .replace(/,/g, " ")
                .replace(/\s+/g, " ")
                .trim();

              const item = new vscode.CompletionItem(cleanKey);
              item.sortText = sortText;
              item.filterText = lineContext;
              item.insertText = new vscode.SnippetString("");
              item.documentation = new vscode.MarkdownString()
                .appendMarkdown(`**Structure Raw:** \`${cleanKey}\`\n\n`)
                .appendMarkdown(`**Frequency:** ${value}\n\n`);

              completionItems.push(item);
            }
            return completionItems;
          }
        }
      );

      vscode.commands.executeCommand("editor.action.triggerSuggest");
    }
  );

  // =============================================================================
  // [Step 2] LLM 기반 텍스트 생성 및 자동완성 UI 표시 ("extension.generateCode")
  // =============================================================================
  const generateCodeCommand = vscode.commands.registerCommand(
    "extension.generateCode",
    () => {
      if (CompletionProvider) {
        try {
          vscode.Disposable.from(CompletionProvider).dispose();
        } catch (e) {
          console.log("[Info] No previous CompletionProvider to dispose.", e);
        }
      }

      CompletionProvider = vscode.languages.registerCompletionItemProvider(
        SUPPORTED_LANGUAGES,
        {
          async provideCompletionItems(
            document: vscode.TextDocument,
            position: vscode.Position
          ): Promise<vscode.CompletionItem[]> {
            const completionItems: vscode.CompletionItem[] = [];

            if (!candidatesData || candidatesData.length === 0) {
              return completionItems;
            }

            const lineContext = document.lineAt(position).text.slice(0, position.character);
            const normalizedLineContext = normalizeCode(lineContext);
            const fullContext = document.getText(new vscode.Range(new vscode.Position(0, 0), position));
            const normalizedFullContext = normalizeCode(fullContext);

            const topCandidates = candidatesData.slice(0, 3);

            for (const { key, value, sortText } of topCandidates) {
              const cleanKey = key
                .replace(/^\[|\]$/g, "")
                .replace(/,/g, " ")
                .replace(/\s+/g, " ")
                .trim();

              console.log(`[Processing LLM Candidate] Hint: ${cleanKey}`);

              let responseText = "";
              if (currentCompletionService) {
                responseText = await currentCompletionService.getTextCandidate(cleanKey, fullContext);
              }

              if (!responseText) { continue; }
              const finalText = refineLLMResponse(
                responseText,
                normalizedFullContext,
                normalizedLineContext,
                cleanKey
              );
              if (!finalText) { continue; }
              console.log(`[Final Code Generated] ${finalText}`);

              const item = new vscode.CompletionItem(finalText);
              item.sortText = sortText;
              item.filterText = lineContext;
              item.insertText = new vscode.SnippetString(finalText);
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

      vscode.commands.executeCommand("editor.action.triggerSuggest");
    }
  );

  // =============================================================================
  // [Step 1] 진입점: 파싱 요청 및 워크플로우 시작 ("extension.triggerParsing")
  // =============================================================================
  const triggerParsingCommand = vscode.commands.registerCommand(
      "extension.triggerParsing",
      () => {
          const activeEditor = vscode.window.activeTextEditor;

          if (!activeEditor) {
              console.log("There are currently no open editors.");
              return;
          }

          const document = activeEditor.document;
          const languageId = document.languageId;
          const config = LANGUAGE_CONFIGS[languageId];

          // 지원하지 않는 언어면 VS Code 기본 자동완성으로 fallback
          if (!config) {
              console.log(`[Info] Unsupported language: "${languageId}". Falling back to default suggest.`);
              vscode.commands.executeCommand("editor.action.triggerSuggest");
              return;
          }

          console.log(`[Info] Triggering parsing for language: "${languageId}" (${config.displayName})`);

          const cursorPosition = activeEditor.selection.active;
          const fullText = document.getText();
          const row = cursorPosition.line + 1;
          const col = cursorPosition.character + 1;

          // CompletionService 인스턴스 생성 (언어별 config 전달)
          const completionService = new CompletionService(
              context.extensionPath,
              languageId,
              config,
              fullText,
              row,
              col
          );
          currentCompletionService = completionService;

          // 콜백 설정: 파싱 완료 후 실행
          completionService.onDataReceived((data: any) => {
              candidatesData = data;
              vscode.commands.executeCommand("extension.previewStructures");
          });

          completionService.getStructCandidates();
      }
  );

  context.subscriptions.push(
    generateCodeCommand,
    previewStructuresCommand,
    triggerParsingCommand
  );
}

// 확장 비활성화 시 호출
export function deactivate() {}
