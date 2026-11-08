# tirno

> raw CDP 위의 다중 세션 브라우저 자동화 CLI 를 **쓰기 위한** 스킬 다섯.
> 도구 자체는 [github.com/Rockheung/tirno](https://github.com/Rockheung/tirno) 에서 받는다.

```bash
claude plugin marketplace add Rockheung/tirno
claude plugin install tirno@tirno
```

## 스킬

| | |
|---|---|
| `tirno` | 명령 레퍼런스 — 세션·소유권·앵커·`@ref` 조작·캐시·기록/재생·진단 |
| `tirno-runbook` | 작업 절차. **조작했다고 됐다고 하지 않는다** — 페이지에서 다시 읽어 확인한 뒤에 됐다고 한다 |
| `tirno-mcp` | chrome-devtools-mcp 의 tool 을 tirno 명령으로 옮기는 대응표 |
| `tirno-sw-override` | 배포 전 빌드를 진짜 origin 위에 얹는 서비스워커 CDN 프록시. 생성기가 `skills/tirno-sw-override/scripts/` 에 들어 있다 |
| `tirno-origin-relay` | 서비스워커 없이 host-resolver 상주로 로컬 빌드를 얹고 목록 밖은 origin 으로 릴레이하는 fallback 프록시. 지연 등록 SW·로그인 뒤 화면용. 생성기가 `skills/tirno-origin-relay/scripts/` 에 따로 있다(serve.mjs·인증서만 낸다) |

## 먼저 필요한 것

도구가 있어야 스킬이 쓸모 있다.

```bash
mkdir -p ~/.local/bin
curl -fsSL https://github.com/Rockheung/tirno/releases/latest/download/tirno-bun-darwin-arm64 -o ~/.local/bin/tirno
chmod +x ~/.local/bin/tirno
tirno --version
tirno setup        # 쓸 브라우저가 없으면 ~/.tirno 로 받아 온다
```

바이너리 하나라 Node 가 필요 없다. 파일명의 타깃은 `darwin-arm64` · `darwin-x64` · `linux-x64` · `linux-arm64`. 자세한 것은 레포의
[docs/ONBOARDING.md](https://github.com/Rockheung/tirno/blob/main/docs/ONBOARDING.md).

## 스킬 본문은 레포가 정본

`.claude/skills/<이름>.md` 가 원본이고 `plugins/tirno/skills/<이름>/SKILL.md` 는 사본이다.
심링크는 쓰지 않는다 — **GitHub 설치는 플러그인 하위트리만 가져가므로 링크가 깨진다.**
`test/plugin-skills.test.ts` 가 사본이 원본과 다르면 CI 를 깨뜨린다.
