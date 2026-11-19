/**
 * Issue #1 regression test: the Electron desktop bridge (`dsh-app://`) fence.
 *
 * Reported shape: under the packaged desktop shell the whole board GUI answers
 * 403. `browserSameOriginMarker` wanted `Sec-Fetch-Site: same-origin` or a
 * present `Origin`, but Chromium attaches no `Sec-Fetch-*` to a request made
 * from a non-http(s) scheme, and a same-origin fetch from `dsh-app://` sends no
 * `Origin` either — so both markers are absent and the fence refuses.
 *
 * The fix is an explicit opt-in (`TaskBoardRouteAccess.trustDesktopBridge`,
 * default false) that admits EXACTLY the header-less shape. Everything that
 * carries a marker keeps the original judgement, so the cross-site surface
 * that the marker exists for does not widen.
 *
 * Run: node --experimental-transform-types _test/desktop-bridge-trust.test.mjs
 */
import { makeTaskBoardRoutes, isTrustedTaskBoardRequest } from '../src/host-routes.ts'
import { resolveDesktopBridgeTrust, TRUST_DESKTOP_BRIDGE_ENV } from '../src/index.ts'
import { TASK_BOARD_API_PREFIX } from '../src/protocol.ts'

let failures = 0
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ` — got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`}`)
}

/** Minimal IncomingMessage stand-in: only the fields the fence reads. */
function makeReq(headers = {}, remoteAddress = '127.0.0.1') {
  return {
    method: 'GET',
    url: `${TASK_BOARD_API_PREFIX}/state`,
    headers: { host: '127.0.0.1:3080', ...headers },
    socket: { remoteAddress },
    once() {},
  }
}

/** Minimal ServerResponse stand-in: captures status + body. */
function makeRes() {
  const out = { status: undefined, body: '' }
  return {
    out,
    writeHead(status) { out.status = status },
    end(payload) { if (payload !== undefined) out.body += String(payload) },
  }
}

/** Only the service surface the /state route touches. */
const service = {
  revision: () => 7,
  snapshot: () => ({ schemaVersion: 1, cards: [], revision: 7 }),
}

/**
 * Drive the real `/state` handler end to end, so the assertion is about the
 * HTTP answer a desktop shell would actually see, not about an internal flag.
 * @param {Record<string, string>} headers - request headers (host is added).
 * @param {object} access - route access passed to makeTaskBoardRoutes.
 * @param {string} [remote] - socket remote address.
 */
function hitState(headers, access, remote = '127.0.0.1') {
  const routes = makeTaskBoardRoutes(service, access)
  const state = routes.find((route) => route.path === `${TASK_BOARD_API_PREFIX}/state`)
  if (state === undefined) throw new Error('state route missing')
  const res = makeRes()
  state.handler(makeReq(headers, remote), res)
  return res.out
}

// ---------------------------------------------------------------- the switch
check('env unset → trust off', resolveDesktopBridgeTrust({}), false)
check('env "0" → trust off', resolveDesktopBridgeTrust({ [TRUST_DESKTOP_BRIDGE_ENV]: '0' }), false)
check('env "false" → trust off', resolveDesktopBridgeTrust({ [TRUST_DESKTOP_BRIDGE_ENV]: 'false' }), false)
check('env "1" → trust on', resolveDesktopBridgeTrust({ [TRUST_DESKTOP_BRIDGE_ENV]: '1' }), true)
check('env "true" → trust on', resolveDesktopBridgeTrust({ [TRUST_DESKTOP_BRIDGE_ENV]: 'true' }), true)

// ------------------------------------------- the reporter's matrix, three rows
// Row 1a: bare request (no Origin, no Sec-Fetch-*) — the desktop shell's shape.
check('★ bare request · switch OFF → 403', hitState({}, {}).status, 403)
check('★ bare request · switch OFF (explicit false) → 403', hitState({}, { trustDesktopBridge: false }).status, 403)
check('★ bare request · switch ON → 200', hitState({}, { trustDesktopBridge: true }).status, 200)

// Row 2: a forged cross-site Origin must stay refused even with the switch on.
check('★ Origin: https://evil.example · switch ON → 403', hitState({ origin: 'https://evil.example' }, { trustDesktopBridge: true }).status, 403)
check('Origin: https://evil.example · switch OFF → 403', hitState({ origin: 'https://evil.example' }, {}).status, 403)

// Row 3: an explicit cross-site fetch marker must stay refused with the switch on.
check('★ Sec-Fetch-Site: cross-site · switch ON → 403', hitState({ 'sec-fetch-site': 'cross-site' }, { trustDesktopBridge: true }).status, 403)
check('Sec-Fetch-Site: cross-site · switch OFF → 403', hitState({ 'sec-fetch-site': 'cross-site' }, {}).status, 403)

// ------------------------------------- unchanged behaviour for marked requests
check('Sec-Fetch-Site: same-origin · switch OFF → 200 (pre-fix path intact)', hitState({ 'sec-fetch-site': 'same-origin' }, {}).status, 200)
check('Origin: http://127.0.0.1:3080 · switch OFF → 200 (pre-fix path intact)', hitState({ origin: 'http://127.0.0.1:3080' }, {}).status, 200)
check('Sec-Fetch-Site: same-origin · switch ON → 200', hitState({ 'sec-fetch-site': 'same-origin' }, { trustDesktopBridge: true }).status, 200)

// A present-but-other marker is NOT the header-less shape: `none` is what a
// browser's own address-bar navigation sends, and it must not ride in on the switch.
check('Sec-Fetch-Site: none · switch ON → 403', hitState({ 'sec-fetch-site': 'none' }, { trustDesktopBridge: true }).status, 403)
check('Sec-Fetch-Site: same-site · switch ON → 403', hitState({ 'sec-fetch-site': 'same-site' }, { trustDesktopBridge: true }).status, 403)

// -------------------------------------------------- the fence is still a fence
check('bare request from a non-loopback socket · switch ON → 403', hitState({}, { trustDesktopBridge: true }, '10.0.0.5').status, 403)
check('bare request without a Host header · switch ON → 403', (() => {
  const routes = makeTaskBoardRoutes(service, { trustDesktopBridge: true })
  const state = routes.find((route) => route.path === `${TASK_BOARD_API_PREFIX}/state`)
  const res = makeRes()
  const req = makeReq()
  delete req.headers.host
  state.handler(req, res)
  return res.out.status
})(), 403)
check('non-GET still 405 · switch ON', (() => {
  const routes = makeTaskBoardRoutes(service, { trustDesktopBridge: true })
  const state = routes.find((route) => route.path === `${TASK_BOARD_API_PREFIX}/state`)
  const res = makeRes()
  const req = makeReq()
  req.method = 'POST'
  state.handler(req, res)
  return res.out.status
})(), 405)

// The predicate itself, independent of the HTTP harness (documented contract).
check('isTrustedTaskBoardRequest · bare + ON → true', isTrustedTaskBoardRequest(makeReq(), { trustedProxyHosts: new Set(), trustDesktopBridge: true }), true)
check('isTrustedTaskBoardRequest · bare + OFF → false', isTrustedTaskBoardRequest(makeReq(), { trustedProxyHosts: new Set() }), false)

// A 200 body must still be the board snapshot (the switch did not stub the route).
check('switch ON returns the real snapshot', hitState({}, { trustDesktopBridge: true }).body, JSON.stringify({ schemaVersion: 1, cards: [], revision: 7 }))

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exitCode = failures === 0 ? 0 : 1
