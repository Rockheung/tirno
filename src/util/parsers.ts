// commander의 option/argument coercer로 `parseInt`/`parseFloat`를 직접 넘기면
// 두 번째 인자(prev value)가 radix로 전달되어 NaN을 만든다. 항상 wrapper 사용.
export const intArg = (v: string): number => parseInt(v, 10);
export const floatArg = (v: string): number => parseFloat(v);

/**
 * stdin 으로 들어온 값의 끝 개행 하나를 뗀다.
 *
 * `echo 'pw' | tirno fill …` 이 흔한 쓰임인데 echo 는 개행을 붙이고, 그 개행이
 * 그대로 들어가면 폼이 조용히 다른 값을 받는다. 하나만 떼는 이유는 여러 줄 값의
 * 마지막 빈 줄까지 삼키지 않기 위해서다.
 */
export function stripTrailingNewline(s: string): string {
  return s.replace(/\r?\n$/, '');
}
