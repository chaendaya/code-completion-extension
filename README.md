# code-completion-extension

(2026/04/27 수정)

Tree-sitter 기반 다중 언어 **구조 후보 자동완성** VS Code 확장.

<br>

## 개요

지원 언어 파일에서 `Ctrl+Space`를 누르면, 커서 위치까지의 코드를 tree-sitter로 파싱하여 그 파싱 상태에서 **다음에 올 수 있는 문법 구조**를 빈도순으로 보여줍니다. `[$ name]`, `[= expression]` 같은 **구조적 토큰 시퀀스**가 후보로 표시됩니다.

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

## 파싱 모드 (Mode 0 / 2)

커서 위치까지 파싱할 때 **커서 이후 소스를 어떻게 다룰지** 두 가지 모드를 제공합니다. 같은 위치라도 **커서 이후 토큰을 lexer 가 미리 보느냐** 에 따라 추출되는 state path 가 달라질 수 있습니다.

| 모드 | 이름 | 동작 | 용도 |
|---|---|---|---|
| **0** (기본값) | Cut | 커서까지 자른 소스만 파서에 전달. 커서 이후는 보지 않음 | 실제 코드 작성 중 자동완성 (사용자가 아직 안 친 부분) |
| **2** | Lookahead | 전체 소스를 전달하되 커서 위치를 별도로 지정. lexer/외부 스캐너가 커서 이후를 lookahead 로 활용 가능 | 평가/벤치마크 (정답이 이미 존재하는 코드에서 과거 시점 시뮬레이션) |

### 모드 변경 방법

F5 -> Extension Development Host 창에서
1. `Ctrl+Shift+P` → 명령 팔레트 열기
2. **"Toggle Parsing Mode (0 ↔ 2)"** 검색 후 실행
3. 현재 값을 0 ↔ 2 로 즉시 전환, 화면 우하단에 `Parsing mode → N` 알림 표시

or
1. `Ctrl+,` → "parsing mode" 검색
2. 드롭다운 0 또는 2 선택


<br>

## 동작 원리

`Ctrl+Space` → `extension.triggerParsing` 명령이 다음을 수행

1. tree-sitter 파서가 커서 위치까지 파싱하여 **state ID 경로**를 추출 (`native/src/addon.cc`)
2. 각 state ID로 `resources/<lang>/candidates.json`에서 구조 후보를 lookup, 빈도 합산 (`src/CompletionService.ts`)
3. 결과를 completion provider로 전달, suggest 위젯에 표시 (`src/extension.ts`)


<br>

## 설치 / 빌드

### Prerequisites (Ctrl+Space 사용자 기준)

- **Node.js 18+** — `npm`, `npx`
- **Python 3** — node-gyp 내부 + `generate_build_config.py` 실행에 사용
  - Linux/macOS: `python3` 명령
  - Windows: `python` 명령이 PATH에 있어야 함
- **C/C++ 컴파일러** — node-gyp가 네이티브 addon(`*.node`) 빌드 시 사용
  - Linux: gcc 또는 clang
  - macOS: Xcode Command Line Tools (`xcode-select --install`)
  - Windows: Visual Studio Build Tools 2019+ (또는 Visual Studio with C++ workload)
- **VS Code 1.85+**



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


### 빌드 절차 (사용자 / cross-platform)

디렉토리 구조 준비 완료 후, `code-completion-extension/` 안에서:

```bash
binding.gyp 삭제
npm install
python3 generate_build_config.py    # Windows: python generate_build_config.py
npx node-gyp rebuild
npm run compile
```




### 실행

VS Code에서 `code-completion-extension` 폴더를 열고 **F5**. Extension Development Host 창이 뜨면 거기서 지원 언어 파일을 열고 `Ctrl+Space`.

지원 언어 테스트파일 : https://drive.google.com/drive/folders/1QDmVdWdUxOeW42Sv6guJWKlyytYyspBX?usp=sharing

<br>

## 새 언어 추가

1. `tree-sitter-<lang>` 저장소를 형제 디렉토리에 clone
2. `resources/<lang>/candidates.json` (state → 후보 매핑)와 `resources/<lang>/token_mapping.json`(토큰 ID → 사람이 읽을 수 있는 이름) 준비
   - 이 두 데이터는 컬렉션 단계로 미리 만들어야 합니다 (본 README 범위 밖)
3. `python3 generate_build_config.py` 실행 → `binding.gyp`/`addon.cc`에 자동 반영
4. `npx node-gyp rebuild`
5. 확장 재시작 → `src/extension.ts`의 `discoverLanguages()`가 `resources/<lang>/`를 자동 인식

