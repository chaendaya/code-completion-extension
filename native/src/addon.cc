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

// SmallBasic 언어 정의 함수 (generated parser에서 제공)
extern "C" TSLanguage *tree_sitter_smallbasic();

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
// [Helper Function] Offset Calculation
// =============================================================================
/**
 * @brief VS Code의 (행, 열) 좌표를 UTF-8 바이트 오프셋으로 변환한다.
 * * Tree-sitter는 바이트 단위 오프셋을 사용하지만, VS Code는 문자 단위(Char) 좌표를 사용하므로
 * 한글 등 멀티바이트 문자가 포함된 경우 변환이 필요하다.
 * * @param text 소스 코드 전체 문자열
 * @param target_row 목표 행
 * @param target_col 목표 열
 * @return size_t 변환된 바이트 오프셋
 */
size_t FindByteOffsetForPosition(const std::string& text, uint32_t target_row, uint32_t target_col) {
    size_t current_offset = 0;
    uint32_t current_row = 0; 
    uint32_t current_col = 0; 
    const uint32_t tab_width = 4;

    while (current_offset < text.length()) {
        if (current_row > target_row || (current_row == target_row && current_col >= target_col)) {
             return current_offset;
        }

        unsigned char current_char = static_cast<unsigned char>(text[current_offset]);

        if (current_char == '\n') {
            current_row++;
            current_col = 0;
            current_offset++;
        } else if (current_char == '\r' && (current_offset + 1 < text.length() && text[current_offset + 1] == '\n')) {
            current_row++;
            current_col = 0;
            current_offset += 2;
        }
        // 제거됨. VS Code의 Position 객체는 Tab을 1개의 character로 취급하여 좌표를 보냄
        // else if (current_char == '\t') {
        //     current_col = ((current_col / tab_width) + 1) * tab_width;
        //     current_offset++;
        // } 
        
        else {
             current_col++;
             current_offset++;
             // UTF-8 멀티바이트 처리
             if (current_char >= 0xC0) { 
                 while (current_offset < text.length() && (static_cast<unsigned char>(text[current_offset]) & 0xC0) == 0x80) {
                     current_offset++;
                 }
             }
        }
    }
    return text.length();
}


// =============================================================================
// [Main API] N-API Export Function
// =============================================================================
/**
 * @brief JS에서 호출 가능한 파싱 및 컨버전 실행 함수
 * * Signature: getPhysicalState(sourceCode: string, row: number, col: number) -> number
 * * @param info[0] sourceCode (string): 전체 소스 코드
 * @param info[1] row (number): 커서 행 (1-based from VS Code extension)
 * @param info[2] col (number): 커서 열 (1-based from VS Code extension)
 * @return array 컨버전 결과
 */
Napi::Value GetConversionResult(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    // 1. 인자 유효성 검사
    if (info.Length() < 3) {
        Napi::TypeError::New(env, "Args: sourceCode, row, col").ThrowAsJavaScriptException();
        return env.Null();
    }

    // 2. 인자 추출
    std::string source_code = info[0].As<Napi::String>().Utf8Value();
    uint32_t stop_row_in = info[1].As<Napi::Number>().Uint32Value();
    uint32_t stop_col_in = info[2].As<Napi::Number>().Uint32Value();

    // 3. Tree-sitter 파서 초기화
    TSLanguage *language = tree_sitter_smallbasic();
    TSParser *parser = ts_parser_new();
    ts_parser_set_language(parser, language);

    // 4. 좌표 보정 및 파서 설정
    uint32_t target_row = stop_row_in > 0 ? stop_row_in - 1 : 0;
    uint32_t target_col = stop_col_in > 0 ? stop_col_in - 1 : 0;

    TSPoint stop_point = {target_row, target_col};
    ts_parser_set_cursor_position(parser, stop_point);

    // 5. 바이트 오프셋 계산 및 파싱 실행
    size_t effective_length = FindByteOffsetForPosition(source_code, target_row, target_col);
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