{
  "targets": [
    {
      "target_name": "c_parser_addon",
      "cflags!": [
        "-fno-exceptions"
      ],
      "cflags_cc!": [
        "-fno-exceptions"
      ],
      "sources": [
        "native/src/addon.cc",
        "../tree-sitter/lib/src/lib.c",
        "../tree-sitter-c/src/parser.c"
      ],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")",
        "../tree-sitter/lib/include",
        "../tree-sitter/lib/src",
        "../tree-sitter-c/src"
      ],
      "defines": [
        "NAPI_DISABLE_CPP_EXCEPTIONS",
        "LANG_C"
      ],
      "msvs_settings": {
        "VCCLCompilerTool": {
          "ExceptionHandling": 1
        }
      }
    },
    {
      "target_name": "cpp_parser_addon",
      "cflags!": [
        "-fno-exceptions"
      ],
      "cflags_cc!": [
        "-fno-exceptions"
      ],
      "sources": [
        "native/src/addon.cc",
        "../tree-sitter/lib/src/lib.c",
        "../tree-sitter-cpp/src/parser.c",
        "../tree-sitter-cpp/src/scanner.c"
      ],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")",
        "../tree-sitter/lib/include",
        "../tree-sitter/lib/src",
        "../tree-sitter-cpp/src"
      ],
      "defines": [
        "NAPI_DISABLE_CPP_EXCEPTIONS",
        "LANG_CPP"
      ],
      "msvs_settings": {
        "VCCLCompilerTool": {
          "ExceptionHandling": 1
        }
      }
    },
    {
      "target_name": "haskell_parser_addon",
      "cflags!": [
        "-fno-exceptions"
      ],
      "cflags_cc!": [
        "-fno-exceptions"
      ],
      "sources": [
        "native/src/addon.cc",
        "../tree-sitter/lib/src/lib.c",
        "../tree-sitter-haskell/src/parser.c",
        "../tree-sitter-haskell/src/scanner.c"
      ],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")",
        "../tree-sitter/lib/include",
        "../tree-sitter/lib/src",
        "../tree-sitter-haskell/src"
      ],
      "defines": [
        "NAPI_DISABLE_CPP_EXCEPTIONS",
        "LANG_HASKELL"
      ],
      "msvs_settings": {
        "VCCLCompilerTool": {
          "ExceptionHandling": 1
        }
      }
    },
    {
      "target_name": "java_parser_addon",
      "cflags!": [
        "-fno-exceptions"
      ],
      "cflags_cc!": [
        "-fno-exceptions"
      ],
      "sources": [
        "native/src/addon.cc",
        "../tree-sitter/lib/src/lib.c",
        "../tree-sitter-java/src/parser.c"
      ],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")",
        "../tree-sitter/lib/include",
        "../tree-sitter/lib/src",
        "../tree-sitter-java/src"
      ],
      "defines": [
        "NAPI_DISABLE_CPP_EXCEPTIONS",
        "LANG_JAVA"
      ],
      "msvs_settings": {
        "VCCLCompilerTool": {
          "ExceptionHandling": 1
        }
      }
    },
    {
      "target_name": "javascript_parser_addon",
      "cflags!": [
        "-fno-exceptions"
      ],
      "cflags_cc!": [
        "-fno-exceptions"
      ],
      "sources": [
        "native/src/addon.cc",
        "../tree-sitter/lib/src/lib.c",
        "../tree-sitter-javascript/src/parser.c",
        "../tree-sitter-javascript/src/scanner.c"
      ],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")",
        "../tree-sitter/lib/include",
        "../tree-sitter/lib/src",
        "../tree-sitter-javascript/src"
      ],
      "defines": [
        "NAPI_DISABLE_CPP_EXCEPTIONS",
        "LANG_JAVASCRIPT"
      ],
      "msvs_settings": {
        "VCCLCompilerTool": {
          "ExceptionHandling": 1
        }
      }
    },
    {
      "target_name": "php_parser_addon",
      "cflags!": [
        "-fno-exceptions"
      ],
      "cflags_cc!": [
        "-fno-exceptions"
      ],
      "sources": [
        "native/src/addon.cc",
        "../tree-sitter/lib/src/lib.c",
        "../tree-sitter-php/php/src/parser.c",
        "../tree-sitter-php/php/src/scanner.c"
      ],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")",
        "../tree-sitter/lib/include",
        "../tree-sitter/lib/src",
        "../tree-sitter-php/php/src"
      ],
      "defines": [
        "NAPI_DISABLE_CPP_EXCEPTIONS",
        "LANG_PHP"
      ],
      "msvs_settings": {
        "VCCLCompilerTool": {
          "ExceptionHandling": 1
        }
      }
    },
    {
      "target_name": "python_parser_addon",
      "cflags!": [
        "-fno-exceptions"
      ],
      "cflags_cc!": [
        "-fno-exceptions"
      ],
      "sources": [
        "native/src/addon.cc",
        "../tree-sitter/lib/src/lib.c",
        "../tree-sitter-python/src/parser.c",
        "../tree-sitter-python/src/scanner.c"
      ],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")",
        "../tree-sitter/lib/include",
        "../tree-sitter/lib/src",
        "../tree-sitter-python/src"
      ],
      "defines": [
        "NAPI_DISABLE_CPP_EXCEPTIONS",
        "LANG_PYTHON"
      ],
      "msvs_settings": {
        "VCCLCompilerTool": {
          "ExceptionHandling": 1
        }
      }
    },
    {
      "target_name": "ruby_parser_addon",
      "cflags!": [
        "-fno-exceptions"
      ],
      "cflags_cc!": [
        "-fno-exceptions"
      ],
      "sources": [
        "native/src/addon.cc",
        "../tree-sitter/lib/src/lib.c",
        "../tree-sitter-ruby/src/parser.c",
        "../tree-sitter-ruby/src/scanner.c"
      ],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")",
        "../tree-sitter/lib/include",
        "../tree-sitter/lib/src",
        "../tree-sitter-ruby/src"
      ],
      "defines": [
        "NAPI_DISABLE_CPP_EXCEPTIONS",
        "LANG_RUBY"
      ],
      "msvs_settings": {
        "VCCLCompilerTool": {
          "ExceptionHandling": 1
        }
      }
    },
    {
      "target_name": "sb_parser_addon",
      "cflags!": [
        "-fno-exceptions"
      ],
      "cflags_cc!": [
        "-fno-exceptions"
      ],
      "sources": [
        "native/src/addon.cc",
        "../tree-sitter/lib/src/lib.c",
        "../tree-sitter-smallbasic/src/parser.c"
      ],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")",
        "../tree-sitter/lib/include",
        "../tree-sitter/lib/src",
        "../tree-sitter-smallbasic/src"
      ],
      "defines": [
        "NAPI_DISABLE_CPP_EXCEPTIONS",
        "LANG_SMALLBASIC"
      ],
      "msvs_settings": {
        "VCCLCompilerTool": {
          "ExceptionHandling": 1
        }
      }
    }
  ]
}
