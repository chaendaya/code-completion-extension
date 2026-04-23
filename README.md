# code-completion-extension

(2026/04/23 작성)

Tree-sitter 기반 다중 언어 **구조 후보 자동완성** VS Code 확장.

<br>

## 개요

지원 언어 파일에서 `Ctrl+Space`를 누르면, 커서 위치까지의 코드를 tree-sitter로 파싱하여 그 파싱 상태에서 **다음에 올 수 있는 문법 구조**를 빈도순으로 보여줍니다. 일반적인 IntelliSense나 스니펫과 달리 식별자/메서드 이름이 아니라 `[$ name]`, `[= expression]` 같은 **구조적 토큰 시퀀스**가 후보로 표시됩니다.

<br>

## 지원 언어

C, C++, Haskell, Java, JavaScript, PHP, Python, Ruby, Small Basic

<br>

## 사용법

1. F5 -> Extension Development Host 창에서 지원 언어 파일을 연다
2. 코드 임의 위치에 커서를 둔다
3. **`Ctrl+Space`** 를 누른다
4. suggest 위젯에 구조 후보가 빈도순으로 표시됨

후보를 선택해도 코드는 변경되지 않습니다

<br>

## 동작 원리

`Ctrl+Space` → `extension.triggerParsing` 명령이 다음을 수행

1. tree-sitter 파서가 커서 위치까지 파싱하여 **state ID 경로**를 추출 (`native/src/addon.cc`)
2. 각 state ID로 `resources/<lang>/candidates.json`에서 구조 후보를 lookup, 빈도 합산 (`src/CompletionService.ts`)
3. 결과를 completion provider로 전달, suggest 위젯에 표시 (`src/extension.ts`)


<br>

## 설치 / 빌드

### Prerequisites

- Node.js 18+
- Python 3
- C/C++ 컴파일러 (gcc / clang / MSVC)
- Rust toolchain (cargo)
- VS Code 1.85+

### 저장소 구조 전제

다음과 같이 디렉토리 구조를 준비해 주세요.

```
parent/
├── code-completion-extension/    <- 이 저장소
├── tree-sitter/                  <- 트리시터
├── tree-sitter-<LANGUAGE>/       <- 지원 언어

```

- 트리시터 : https://github.com/SwlabTreeSitter/tree-sitter/tree/Candidate_Collection
- 지원 언어 
   - small basic : https://github.com/chaendaya/tree-sitter-smallbasic
   - 그 외 : https://github.com/tree-sitter/tree-sitter/wiki/List-of-parsers 에서 지원 언어 검색하여 다운로드


### 빌드 절차

디렉토리 구조 준비 완료 후

```bash
# 1. tree-sitter 저장소의 통합 빌드 스크립트 실행
#    (cargo build + code-completion-extension의 npm install + node-gyp rebuild까지 한 번에)
cd ../tree-sitter
./run_pipeline_all.sh --build-only

# 2. TypeScript 컴파일 (위 스크립트에는 포함되어 있지 않음)
cd ../code-completion-extension
npm run compile
```

### 실행

VS Code에서 `code-completion-extension` 폴더를 열고 **F5**. Extension Development Host 창이 뜨면 거기서 지원 언어 파일을 열고 `Ctrl+Space`.

<br>

## 새 언어 추가

1. `tree-sitter-<lang>` 저장소를 형제 디렉토리에 clone
2. `resources/<lang>/candidates.json` (state → 후보 매핑)와 `resources/<lang>/token_mapping.json`(토큰 ID → 사람이 읽을 수 있는 이름) 준비
   - 이 두 데이터는 컬렉션 단계로 미리 만들어야 합니다 (본 README 범위 밖)
3. `python3 generate_build_config.py` 실행 → `binding.gyp`/`addon.cc`에 자동 반영
4. `npx node-gyp rebuild`
5. 확장 재시작 → `src/extension.ts`의 `discoverLanguages()`가 `resources/<lang>/`를 자동 인식

