// extension.ts
// VS Code 확장 프로그램의 메인 진입점 (다중 언어 지원)
// Step 1. [Ctrl+Space] -> 'extension.triggerParsing': 파싱 → 구조적 후보 도출
// Step 2. [Callback]   -> candidatesData 갱신 → triggerSuggest (등록된 provider가 즉시 응답)
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

type StructuralCandidate = {
  key: string;      // 예: "[ID, =, STR]"
  value: number;    // 빈도수
  sortText: string; // 정렬 순위
};

let candidatesData: StructuralCandidate[] = [];
let currentCompletionService: CompletionService | undefined;

// Provider가 응답해야 하는 시점을 제어하는 플래그
// true: 우리가 파싱한 결과를 보여줄 준비됨
// false: 일반 VS Code 자동완성에 개입하지 않음
let structuralCandidatesReady = false;
let llmCandidatesReady = false;
let llmCandidatesData: StructuralCandidate[] = [];

export function activate(context: vscode.ExtensionContext) {
  console.log("Running the VSC Extension");

  // =============================================================================
  // [Helper Functions]
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

  function refineLLMResponse(
    responseText: string,
    normalizedFullContext: string,
    normalizedLineContext: string,
    structuralHint: string
  ): string | null {
      const normalizedResponse = normalizeCode(responseText);

      const normalizedHint = structuralHint.replace(/\s/g, "");
      if (normalizedResponse.replace(/\s/g, "") === normalizedHint) {
          console.log("-> Skipped: LLM just repeated the hint.");
          return null;
      }

      let finalText = responseText;
      if (normalizedResponse.includes(normalizedFullContext)) {
          finalText = normalizedResponse.replace(normalizedFullContext, '');
      } else if (normalizedResponse.includes(normalizedLineContext)) {
          finalText = normalizedResponse.replace(normalizedLineContext, '');
      }

      finalText = finalText
          .replace(/=/g, " = ")
          .replace(/</g, " < ")
          .replace(/>/g, " > ")
          .trim();

      return finalText;
  }

  function buildFilterText(lineContext: string): string {
    // VS Code의 단어 경계 기준으로 커서 앞 단어만 추출
    // 예: "#include" → "include" (# 는 단어 구분자)
    // 예: "TextWindow." → "" → lineContext fallback
    const wordMatch = lineContext.match(/[a-zA-Z_][a-zA-Z_0-9]*$/);
    return wordMatch ? wordMatch[0] : lineContext;
  }

  // =============================================================================
  // [구조적 후보 Provider] activate 시 한 번만 등록
  // - structuralCandidatesReady 플래그가 true일 때만 응답
  // - 그 외에는 undefined 반환 → VS Code 기본 자동완성 유지
  // =============================================================================
  const structuralProvider = vscode.languages.registerCompletionItemProvider(
    SUPPORTED_LANGUAGES,
    {
      async provideCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position
      ): Promise<vscode.CompletionItem[] | undefined> {
        if (!structuralCandidatesReady) {
          return undefined;
        }

        const lineContext = document.lineAt(position).text.slice(0, position.character);
        const filterText = buildFilterText(lineContext);

        if (!candidatesData || candidatesData.length === 0) {
          const placeholder = new vscode.CompletionItem("(No candidates found)");
          placeholder.insertText = new vscode.SnippetString("");
          placeholder.filterText = filterText;
          placeholder.sortText = "000";
          return [placeholder];
        }

        const topCandidates = candidatesData.slice(0, 20);
        return topCandidates.map(({ key, value, sortText }) => {
          // DB key는 공백으로 구분된 토큰 나열 형식이므로 그대로 표시
          const cleanKey = key;

          const item = new vscode.CompletionItem(cleanKey);
          item.sortText = sortText;
          item.filterText = filterText;
          item.insertText = new vscode.SnippetString("");
          item.documentation = new vscode.MarkdownString()
            .appendMarkdown(`**Structure:** \`${cleanKey}\`\n\n`)
            .appendMarkdown(`**Frequency:** ${value}\n\n`);
          return item;
        });
      }
    }
  );

  // =============================================================================
  // [LLM 후보 Provider] activate 시 한 번만 등록
  // - llmCandidatesReady 플래그가 true일 때만 응답
  // =============================================================================
  const llmProvider = vscode.languages.registerCompletionItemProvider(
    SUPPORTED_LANGUAGES,
    {
      async provideCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position
      ): Promise<vscode.CompletionItem[] | undefined> {
        if (!llmCandidatesReady) {
          return undefined;
        }

        const lineContext = document.lineAt(position).text.slice(0, position.character);
        const filterText = buildFilterText(lineContext);

        return llmCandidatesData.map(({ key: finalText, value, sortText }) => {
          const item = new vscode.CompletionItem(finalText);
          item.sortText = sortText;
          item.filterText = filterText;
          item.insertText = new vscode.SnippetString(finalText);
          item.documentation = new vscode.MarkdownString()
            .appendMarkdown(`**Generated Code:** \`${finalText}\`\n\n`)
            .appendMarkdown(`**Frequency:** ${value}`);
          return item;
        });
      }
    }
  );

  // =============================================================================
  // [Step 1.5] previewStructures — 플래그 세우고 triggerSuggest만 호출
  // Provider 재등록 없음 → IPC 타이밍 문제 없음
  // =============================================================================
  const previewStructuresCommand = vscode.commands.registerCommand(
    "extension.previewStructures",
    () => {
      llmCandidatesReady = false;
      structuralCandidatesReady = true;
      vscode.commands.executeCommand("editor.action.triggerSuggest");
    }
  );

  // =============================================================================
  // [Step 2] generateCode — LLM 호출 후 플래그 세우고 triggerSuggest
  // =============================================================================
  const generateCodeCommand = vscode.commands.registerCommand(
    "extension.generateCode",
    async () => {
      if (!candidatesData || candidatesData.length === 0 || !currentCompletionService) {
        return;
      }

      const activeEditor = vscode.window.activeTextEditor;
      if (!activeEditor) { return; }

      const position = activeEditor.selection.active;
      const document = activeEditor.document;
      const lineContext = document.lineAt(position).text.slice(0, position.character);
      const normalizedLineContext = normalizeCode(lineContext);
      const fullContext = document.getText(new vscode.Range(new vscode.Position(0, 0), position));
      const normalizedFullContext = normalizeCode(fullContext);

      const topCandidates = candidatesData.slice(0, 3);
      const results: StructuralCandidate[] = [];

      for (const { key, value, sortText } of topCandidates) {
        const cleanKey = key
          .replace(/^\[|\]$/g, "")
          .replace(/,/g, " ")
          .replace(/\s+/g, " ")
          .trim();

        console.log(`[Processing LLM Candidate] Hint: ${cleanKey}`);
        const responseText = await currentCompletionService.getTextCandidate(cleanKey, fullContext);
        if (!responseText) { continue; }

        const finalText = refineLLMResponse(responseText, normalizedFullContext, normalizedLineContext, cleanKey);
        if (!finalText) { continue; }
        console.log(`[Final Code Generated] ${finalText}`);

        results.push({ key: finalText, value, sortText });
      }

      llmCandidatesData = results;
      structuralCandidatesReady = false;
      llmCandidatesReady = true;
      vscode.commands.executeCommand("editor.action.triggerSuggest");
    }
  );

  // =============================================================================
  // [Step 1] triggerParsing — Ctrl+Space 진입점
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

          if (!config) {
              console.log(`[Info] Unsupported language: "${languageId}". Falling back to default suggest.`);
              vscode.commands.executeCommand("editor.action.triggerSuggest");
              return;
          }

          console.log(`[Info] Triggering parsing for language: "${languageId}" (${config.displayName})`);

          // 다음 파싱 전까지 이전 결과 비활성화
          structuralCandidatesReady = false;
          llmCandidatesReady = false;
          candidatesData = [];

          const cursorPosition = activeEditor.selection.active;
          const fullText = document.getText();
          const row = cursorPosition.line + 1;
          const col = cursorPosition.character + 1;

          const completionService = new CompletionService(
              context.extensionPath,
              languageId,
              config,
              fullText,
              row,
              col
          );
          currentCompletionService = completionService;

          completionService.onDataReceived((data: any) => {
              candidatesData = data;
              vscode.commands.executeCommand("extension.previewStructures");
          });

          completionService.getStructCandidates();
      }
  );

  context.subscriptions.push(
    structuralProvider,
    llmProvider,
    generateCodeCommand,
    previewStructuresCommand,
    triggerParsingCommand
  );
}

export function deactivate() {}
