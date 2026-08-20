// commander의 option/argument coercer로 `parseInt`/`parseFloat`를 직접 넘기면
// 두 번째 인자(prev value)가 radix로 전달되어 NaN을 만든다. 항상 wrapper 사용.
export const intArg = (v: string): number => parseInt(v, 10);
export const floatArg = (v: string): number => parseFloat(v);
