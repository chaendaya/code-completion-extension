// extension.ts
// VS Code 확장 프로그램의 메인 진입점 (다중 언어 지원)
// Step 1. [Ctrl+Space] -> 'extension.triggerParsing': 파싱 → 구조적 후보 도출
// Step 2. [Callback]   -> structuralCandidatesData 갱신 → triggerSuggest (등록된 provider가 즉시 응답)
import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { CompletionService, LanguageConfig } from "./CompletionService";

// =============================================================================
// [언어 설정 맵] resources/ 디렉토리를 스캔하여 자동 생성
// =============================================================================
// addon 이름 예외 매핑 (디렉토리명과 addon 접두사가 다른 경우)
const ADDON_NAME_OVERRIDES: Record<string, string> = {
  "smallbasic": "sb_parser_addon",
};

let LANGUAGE_CONFIGS: Record<string, LanguageConfig> = {};
let SUPPORTED_LANGUAGES: string[] = [];

function discoverLanguages(extensionPath: string) {
  const resourcesDir = path.join(extensionPath, "resources");
  if (!fs.existsSync(resourcesDir)) { return; }

  const dirs = fs.readdirSync(resourcesDir, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name);

  for (const lang of dirs) {
    const candidatesPath = path.join(resourcesDir, lang, "candidates.json");
    if (!fs.existsSync(candidatesPath)) { continue; }

    const addonName = ADDON_NAME_OVERRIDES[lang] || `${lang}_parser_addon`;
    LANGUAGE_CONFIGS[lang] = {
      addonName,
      candidatesFile: "candidates.json",
      tokenMapFile: "token_mapping.json",
      displayName: lang.charAt(0).toUpperCase() + lang.slice(1),
    };
  }
  SUPPORTED_LANGUAGES = Object.keys(LANGUAGE_CONFIGS);
  console.log(`[Info] Discovered languages: ${SUPPORTED_LANGUAGES.join(", ")}`);
}

// 자동완성 후보의 공통 shape
// - structuralCandidatesData[].key: 구조 패턴 (예: "[ID, =, STR]")
// - textualCandidatesData[].key:    LLM이 생성한 실제 코드 텍스트
type CompletionCandidate = {
  key: string;
  value: number;    // 빈도수
  sortText: string; // 정렬 순위
};

let structuralCandidatesData: CompletionCandidate[] = [];
let textualCandidatesData: CompletionCandidate[] = [];

let currentCompletionService: CompletionService | undefined;

// Provider가 응답해야 하는 시점을 제어하는 플래그
// true: 우리가 파싱한 결과를 보여줄 준비됨
// false: 일반 VS Code 자동완성에 개입하지 않음
let structuralCandidatesReady = false;
let llmCandidatesReady = false;

export function activate(context: vscode.ExtensionContext) {
  console.log("Running the VSC Extension");
  discoverLanguages(context.extensionPath);

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

  // =============================================================================
  // [구조적 후보 Provider] activate 시 한 번만 등록
  // - structuralCandidatesReady 플래그가 true일 때만 응답
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

        const wordRange = document.getWordRangeAtPosition(position);
        const typedWord = wordRange ? document.getText(wordRange) : "";
        // 구조 후보는 시각적 힌트이므로 삽입은 no-op로 두고, range는 커서 위치의 빈 범위로 둔다.
        // → 사용자가 우연히 Tab/Enter를 눌러도 타이핑한 단어가 치환되어 사라지지 않음.
        const insertRange = new vscode.Range(position, position);
        // filterText를 VS Code가 잡은 typedWord로 맞춰서 클라이언트 필터링이 항상 통과하게 한다.
        const matchAllFilter = typedWord || "_";
        console.log(`[StructuralProvider] typedWord: ${JSON.stringify(typedWord)}, items: ${structuralCandidatesData?.length ?? 0}`);

        if (!structuralCandidatesData || structuralCandidatesData.length === 0) {
          const placeholder = new vscode.CompletionItem("(No candidates found)");
          placeholder.insertText = "";
          placeholder.filterText = matchAllFilter;
          placeholder.range = insertRange;
          placeholder.sortText = "000";
          return [placeholder];
        }

        const topCandidates = structuralCandidatesData;
        return topCandidates.map(({ key, value, sortText }) => {
          // DB key는 공백으로 구분된 토큰 나열 형식이므로 그대로 표시
          const cleanKey = key;

          const item = new vscode.CompletionItem(cleanKey, vscode.CompletionItemKind.Property);
          item.sortText = sortText;
          item.filterText = matchAllFilter;
          item.insertText = "";
          item.range = insertRange;
          item.preselect = sortText === "001";
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

        const wordRange = document.getWordRangeAtPosition(position);
        const typedWord = wordRange ? document.getText(wordRange) : "";
        // LLM 후보는 typedWord 자리에 삽입 (실제 코드 완성)
        const insertRange = wordRange ?? new vscode.Range(position, position);
        const matchAllFilter = typedWord || "_";

        return textualCandidatesData.map(({ key: finalText, value, sortText }) => {
          const item = new vscode.CompletionItem(finalText, vscode.CompletionItemKind.Property);
          item.sortText = sortText;
          item.filterText = matchAllFilter;
          item.insertText = new vscode.SnippetString(finalText);
          item.range = insertRange;
          item.preselect = sortText === "001";
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
      if (!structuralCandidatesData || structuralCandidatesData.length === 0 || !currentCompletionService) {
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

      const topCandidates = structuralCandidatesData.slice(0, 3);
      const results: CompletionCandidate[] = [];

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

      textualCandidatesData = results;
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
          structuralCandidatesData = [];

          const cursorPosition = activeEditor.selection.active;
          const fullText = document.getText();

          // 바이트 오프셋 계산: VS Code의 offsetAt()은 문자 단위이므로
          // Buffer.byteLength로 UTF-8 바이트 오프셋으로 변환
          const charOffset = document.offsetAt(cursorPosition);
          const textBeforeCursor = fullText.substring(0, charOffset);
          const byteOffset = Buffer.byteLength(textBeforeCursor, 'utf8');

          console.log(`[triggerParsing] Constructing CompletionService at byteOffset=${byteOffset}, charOffset=${charOffset}`);
          const completionService = new CompletionService(
              context.extensionPath,
              languageId,
              config,
              fullText,
              byteOffset
          );
          currentCompletionService = completionService;
          console.log("[triggerParsing] Constructor returned, registering callback");

          completionService.onDataReceived((data: any) => {
              console.log(`[triggerParsing] onDataReceived fired with ${Array.isArray(data) ? data.length : "non-array"} items`);
              structuralCandidatesData = data;
              vscode.commands.executeCommand("extension.previewStructures").then(
                  () => console.log("[triggerParsing] previewStructures command done"),
                  (err) => console.error("[triggerParsing] previewStructures command failed", err)
              );
          });

          console.log("[triggerParsing] About to call getStructCandidates");
          try {
              completionService.getStructCandidates();
              console.log("[triggerParsing] getStructCandidates returned");
          } catch (e) {
              console.error("[triggerParsing] getStructCandidates threw:", e);
          }
      }
  );

  // =============================================================================
  // [Toggle] 파싱 모드 0 ↔ 2 전환
  // =============================================================================
  const toggleParsingModeCommand = vscode.commands.registerCommand(
    "extension.toggleParsingMode",
    async () => {
      const cfg = vscode.workspace.getConfiguration('completion');
      const cur = cfg.get<number>('parsingMode', 0);
      const next = cur === 0 ? 2 : 0;
      await cfg.update('parsingMode', next, vscode.ConfigurationTarget.Global);
      vscode.window.showInformationMessage(`Parsing mode → ${next}`);
    }
  );

  context.subscriptions.push(
    structuralProvider,
    llmProvider,
    generateCodeCommand,
    previewStructuresCommand,
    triggerParsingCommand,
    toggleParsingModeCommand
  );
}

export function deactivate() {}
