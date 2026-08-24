/**
 * Chromium 이 왜 못 떴는지는 stderr 가 정확히 말해준다. 그것을 그대로 통과시키는
 * 것은 옳다 — 문제는 그 다음이다.
 *
 * Ubuntu 24.04 는 `kernel.apparmor_restrict_unprivileged_userns=1` 이라 chromium
 * 자체 샌드박스가 못 뜨고, stderr 는 "you can try using --no-sandbox" 라고 한다.
 * 그런데 그 플래그를 tirno 에 어떻게 넘기는지는 stderr 도 `--help` 도 안 알려준다.
 * chromium 의 조언을 tirno 문법으로 **번역하는 일을 사용자가 직접 해야 했다**(#134).
 *
 * 그래서 실패한 그 명령줄에 플래그를 얹어 복붙 가능한 형태로 돌려준다. 번역을
 * 도구가 한다.
 */

const SANDBOX_MARKERS = [
  'No usable sandbox',
  'SUID sandbox helper binary',
  'namespace sandbox',
];

/** 셸에 그대로 붙여넣을 수 있게. 값에 공백·따옴표가 있으면 감싼다. */
function shellQuote(arg: string): string {
  if (arg.length > 0 && !/[\s'"$`\\|&;<>()*?[\]{}!#~]/.test(arg)) return arg;
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

/**
 * 실행된 명령줄에 chrome 플래그를 얹은 재시도 명령.
 *
 * `--` 가 이미 있으면 그 뒤에 붙인다 — 새로 하나 더 열면 첫 번째 것 뒤의 플래그가
 * 전부 두 번째 `--` 의 인자로 밀려서 명령이 달라진다. 이미 들어 있는 플래그는
 * 다시 넣지 않는다.
 */
export function retryWithChromeFlags(argv: string[], flags: string[]): string {
  const args = argv.slice(2);
  const separator = args.indexOf('--');
  const existing = separator >= 0 ? args.slice(separator + 1) : [];
  const missing = flags.filter(f => !existing.some(e => e === f || e.startsWith(`${f}=`)));
  const merged = separator >= 0
    ? [...args.slice(0, separator), '--', ...existing, ...missing]
    : [...args, '--', ...missing];
  return ['tirno', ...merged.map(shellQuote)].join(' ');
}

/**
 * 기동 실패 메시지에 덧붙일 안내. 샌드박스 실패가 아니면 `null` —
 * 아무 실패에나 `--no-sandbox` 를 권하면 그것은 조언이 아니라 소음이다.
 */
export function sandboxHint(stderr: string, argv: string[]): string | null {
  if (!SANDBOX_MARKERS.some(m => stderr.includes(m))) return null;
  return [
    '',
    'Chromium 의 샌드박스가 못 떴다. 그 플래그는 `--` 뒤로 넘긴다:',
    `  ${retryWithChromeFlags(argv, ['--no-sandbox'])}`,
    '',
    '--no-sandbox 는 우회지 해법이 아니다. 샌드박스를 켠 채로 돌리려면 그 바이너리에만',
    'userns 를 허용하는 AppArmor 프로파일을 준다 — docs/COMMANDS.md 의 "샌드박스" 절.',
  ].join('\n');
}
