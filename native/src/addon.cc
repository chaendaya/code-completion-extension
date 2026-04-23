/**
 * @file addon.cc
 * @brief SmallBasic 파서와 상호작용하기 위한 Node.js Native Addon (N-API)
 * * VS Code Extension(JS/TS)에서 소스 코드를 받아 Tree-sitter의 내부 파싱 상태(State ID)를 반환한다.
 * 이 State ID는 구조적 자동완성 후보를 조회하는 키로 사용된다.
 */

#include <napi.h>
#include <iostream>
#include <string>
#include <vector>
#include <algorithm>

// binding.gyp의 include_dirs 설정을 통해 참조되는 Tree-sitter API 헤더
#include "tree_sitter/api.h"

// =============================================================================
// [External Declarations]
// C 언어로 작성된 Tree-sitter 파서 및 내부 함수들을 링크하기 위한 선언
// =============================================================================

// 언어 정의 함수 — generate_build_config.py에 의해 자동 생성됨
#if defined(LANG_C)
    extern "C" TSLanguage *tree_sitter_c();
    #define GET_LANGUAGE() tree_sitter_c()
#elif defined(LANG_CPP)
    extern "C" TSLanguage *tree_sitter_cpp();
    #define GET_LANGUAGE() tree_sitter_cpp()
#elif defined(LANG_HASKELL)
    extern "C" TSLanguage *tree_sitter_haskell();
    #define GET_LANGUAGE() tree_sitter_haskell()
#elif defined(LANG_JAVA)
    extern "C" TSLanguage *tree_sitter_java();
    #define GET_LANGUAGE() tree_sitter_java()
#elif defined(LANG_JAVASCRIPT)
    extern "C" TSLanguage *tree_sitter_javascript();
    #define GET_LANGUAGE() tree_sitter_javascript()
#elif defined(LANG_PHP)
    extern "C" TSLanguage *tree_sitter_php();
    #define GET_LANGUAGE() tree_sitter_php()
#elif defined(LANG_PYTHON)
    extern "C" TSLanguage *tree_sitter_python();
    #define GET_LANGUAGE() tree_sitter_python()
#elif defined(LANG_RUBY)
    extern "C" TSLanguage *tree_sitter_ruby();
    #define GET_LANGUAGE() tree_sitter_ruby()
#elif defined(LANG_SMALLBASIC)
    extern "C" TSLanguage *tree_sitter_smallbasic();
    #define GET_LANGUAGE() tree_sitter_smallbasic()
#else
    #error "언어 정의 없음: generate_build_config.py를 실행하세요."
#endif

// 커스텀 파서 로직 함수 (lib/src/parser.c에 구현됨)
extern "C" {
    // 1. 컨버전 로직 실행
    TSStatePath ts_parser_parse_string_for_conversion(TSParser *self, const TSTree *old_tree, const char *string, uint32_t length);

    // 2. 컨버전 결과 출력 (파일 or 화면)
    void ts_parser_write_conversion_result(TSParser *self, TSStatePath *path, FILE *fp);

    // 3. 로그 덤프
    void ts_parser_write_logged_actions(TSParser *self, const char *filename);
}

// =============================================================================
// [Main API] N-API Export Function
// =============================================================================
/**
 * @brief JS에서 호출 가능한 파싱 및 컨버전 실행 함수
 *
 * Signature: getConversionResult(sourceCode: string, byteOffset: number) -> number[]
 *
 * @param info[0] sourceCode (string): 전체 소스 코드
 * @param info[1] byteOffset (number): 커서 위치의 UTF-8 바이트 오프셋
 * @return array 컨버전 결과 (상태 경로)
 */
Napi::Value GetConversionResult(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    // 1. 인자 유효성 검사
    if (info.Length() < 2) {
        Napi::TypeError::New(env, "Args: sourceCode, byteOffset").ThrowAsJavaScriptException();
        return env.Null();
    }

    // 2. 인자 추출
    std::string source_code = info[0].As<Napi::String>().Utf8Value();
    uint32_t byte_offset = info[1].As<Napi::Number>().Uint32Value();

    // 3. Tree-sitter 파서 초기화
    TSLanguage *language = GET_LANGUAGE();
    TSParser *parser = ts_parser_new();
    ts_parser_set_language(parser, language);

    // 4. 바이트 오프셋으로 파싱 길이 결정 (FindByteOffsetForPosition 불필요)
    size_t effective_length = byte_offset;
    if (effective_length > source_code.length()) effective_length = source_code.length();

    TSTree *tree = ts_parser_parse_string(
        parser, NULL, source_code.c_str(), static_cast<uint32_t>(effective_length)
    );

    // [로그 덤프] logged_actions.txt 저장
    ts_parser_write_logged_actions(parser, "logged_actions.txt");

    // 6. 컨버전 로직 적용
    TSStatePath path = ts_parser_parse_string_for_conversion(
        parser, NULL, source_code.c_str(), static_cast<uint32_t>(effective_length)
    );
    ts_parser_write_conversion_result(parser, &path, stdout);
    
    Napi::Array js_array = Napi::Array::New(env, path.count);
    for (uint32_t i = 0; i < path.count; i++) {
        // 구조체 내부의 states를 저장
        js_array.Set(i, path.states[i]);
    }

    // 7. 메모리 해제
    if (tree) ts_tree_delete(tree);
    ts_parser_delete(parser);

    return js_array;
}

// =============================================================================
// [Module Initialization]
// =============================================================================

Napi::Object Init(Napi::Env env, Napi::Object exports) {
    // JS에서 'getConversionResult'라는 이름으로 함수를 노출
    exports.Set(Napi::String::New(env, "getConversionResult"), Napi::Function::New(env, GetConversionResult));
    return exports;
}

NODE_API_MODULE(sb_parser_addon, Init)