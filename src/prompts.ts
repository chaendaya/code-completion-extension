// export const SYSTEM_ROLE = "You are a helpful assistant that provides programming code suggestions while typing code in an IDE. Just answer concisely and place your answer after the provided code.";

// // 논문에서 사용한 문법 규칙 및 정의 데이터 (Context Injection)
// export const GRAMMAR_CONTEXT_MESSAGES = [
//     {
//         role: "assistant", // 원본 유지
//         content: `This is a SmallBasic Programming Language code:
// TextWindow.WriteLine("Hello World") is tokenized into a stream,
// ID . ID ( STR )

// The term “TextWindow” is processed into an identifier represented by the terminal ID, while a text dot is interpreted as a terminal dot. 
// Similarly, “WriteLine” is analyzed like TextWindow. Open and close parentheses undergo the same procedure as the dot, and the string 
// literal "Hello World" is translated into the terminal STR.`
//     },
//     {
//         role: "assistant",
//         content: `What are structural candidates ?
// TextWindow.WriteLine("Hello World")

// Production Rule: ExprStatement ->  ID . ID ( Exprs )

// For example, programmers have written “TextWindow.(dot)”. Currently cursor at this position after the dot. At this point, programmers want 
// the editor to complete the rest of the part of this line of code. Then our system looks for the appropriate production rule. Next, our system 
// gets the rest of the symbols from that production rule. Our system considered this part as a structural candidate. We ask the ChatGPT to decorate 
// the structural candidate by giving the prefix what the programmer writes before asking for code suggestions and the structural candidate.`
//     },
//     {
//         role: "assistant",
//         content: `For instance,
// number = 100
// While(number>1)
// TextWindow.WriteLine(number)
// Suggestions: 
// ID = Expr

// In the above example, the suggestion at the cursor position is an assignment statement formatted as ID = Expr. 
// Here, the terminal ID signifies an identifier, the terminal = represents an assignment symbol, and the non-terminal “Expr” indicates 
// an expression. Further, the third example in Figure 1 delves deeper into the syntax structures of “Expr”  after users input an identifier, 
// number, followed by an assignment symbol. In contrast, Microsoft SmallBasic does not provide any suggestions at the same cursor position 
// until the user starts typing the initial character n. Only then do suggestions appear, revealing one variable name, number, and one class 
// name, Network, both beginning with that character.`
//     },
//     {
//         role: "assistant",
//         content: `Problem statement: This is the incomplete SmallBasic programming language code:
// number = 100
// While(number>1)
// TextWindow
// 'ID (Expr)'
// Complete the 'ID (Expr)' part of the code in the SmallBasic programming language.                    
// Just show your answer in place of 'ID (Expr)'. 
// Your solution: .WriteLine(number)
// Expected solution: .WriteLine(number)`
//     }
// ] as const;

// export function generateCompletionPrompt(fullContext: string, structCandidate: string): string {
//     const quotedHint = `'${structCandidate}'`;
//     return `Problem statement: This is the incomplete SmallBasic programming language code:
// ${fullContext}
// ${quotedHint}
// Complete the ${quotedHint} part of the code in the SmallBasic programming language.                   
// Just show your answer in place of ${quotedHint}.`;
// }

// [수정 전]
// export const SYSTEM_ROLE = "You are a helpful assistant for Microsoft Small Basic...";

// [수정 후: 엄격한 페르소나 설정]
export const SYSTEM_ROLE = `
You are a strict code completion engine.
Your goal is to generate code based on a provided syntax structure.

RULES:
1. Output ONLY the code snippet.
2. DO NOT include conversational text (e.g., "Here is the code", "Sure").
3. DO NOT include markdown backticks.
4. DO NOT explain the code.
5. If the context is insufficient, generate a plausible dummy variable or value (e.g., "x", "10", "Hello").
`;

// export function generateCompletionPrompt(fullContext: string, structCandidate: string): string {
//     // LLM에게 명확한 예시(Few-shot)를 줘서 말투를 교정합니다.

//     return `
// Task: Fill in the missing code based on the Target Structure.

// [Example 1]
// Context: TextWindow.
// Target Structure: Identifier ( Expr )
// Output: WriteLine("Hello World")

// [Example 2]
// Context: For i = 1 
// Target Structure: To NUM
// Output: To 10

// [Example 3]
// Context: If x > 10 
// Target Structure: Then
// Output: Then

// [Current Task]
// Context: ${fullContext}
// Target Structure: ${structCandidate}
// Output:`;
// }

export function generateCompletionPrompt(fullContext: string, structCandidate: string, languageName: string): string {
    return `
This is the incomplete ${languageName} code: ${fullContext}  '${structCandidate}'
Complete the '${structCandidate}' part of the code in ${languageName}.
Just show your answer in place of '${structCandidate}'`;
}