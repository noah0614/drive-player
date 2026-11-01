/* Google Drive Player — 스트리밍 프록시 서비스워커.
   <video>/<audio> 태그는 커스텀 HTTP 헤더(Authorization)를 실을 방법이 없다.
   Drive API로 원본 바이트를 받으려면 이 헤더가 필수라서, 같은 출처의
   "stream/<fileId>?size=<bytes>" 요청을 여기서 가로채 Authorization을 붙여
   Drive API로 대신 요청하고, 그 응답(Range 지원 포함)을 그대로 돌려준다.
   이렇게 하면 브라우저의 video 엔진이 평소처럼 Range 요청을 날리며 진짜
   스트리밍·탐색을 하고, 페이지 JS가 파일 전체를 메모리에 들고 있지 않아도 된다.

   Content-Range를 직접 계산하는 이유:
   구글 API(www.googleapis.com)로 보내는 fetch는 진짜 크로스오리진 요청이라
   브라우저의 CORS 규칙을 그대로 받는다. Content-Length/Content-Type 등은
   "CORS-safelisted response header"라 별다른 설정 없이도 JS에서 읽히지만,
   Content-Range·Accept-Ranges·ETag는 여기 포함되지 않는다 — 구글이 실제로는
   정상적인 206 + Content-Range를 응답해도, 이 서비스워커의 fetch()로는 그
   Content-Range 값 자체를 읽을 수 없다(Access-Control-Expose-Headers로 명시
   노출하지 않는 한). Content-Range 없는 206 응답은 스펙 위반이라 브라우저의
   video 엔진이 이를 디코딩 실패로 취급해버린다 — 코덱과 무관하게 어떤 파일이든
   재생이 깨졌던 진짜 원인이 이것이었다. 그래서 총 파일 크기(size, 페이지가 Drive
   목록 조회 때 함께 받아 쿼리스트링에 실어 보낸다)와, 우리 자신이 받은 요청의
   Range 헤더(이건 크로스오리진이 아니므로 제약 없이 읽힌다)를 가지고 Content-Range를
   직접 만들어 낸다. */

let token = null;

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "token") {
    token = event.data.value;
  }
});

/* 토큰을 페이지에 다시 묻는다.
   브라우저는 한가한 서비스워커(예: 영상을 일시정지해 둔 동안)를 수시로 내렸다가 다음
   요청 때 새로 띄우는데, 그러면 위의 전역 변수 token이 비어 버린다. 예전엔 그 상태로
   401을 돌려줘서 일시정지 후 다시 재생하면 영상이 멈췄다. 이제는 요청을 보낸 페이지
   (없으면 열려 있는 아무 창)에 MessageChannel로 물어서 받아 온다 — 답은 index.html의
   "need-token" 리스너가 한다. */
function askToken(client) {
  return new Promise((resolve) => {
    const ch = new MessageChannel();
    const timer = setTimeout(() => resolve(null), 3000);
    ch.port1.onmessage = (e) => { clearTimeout(timer); resolve(e.data && e.data.value); };
    client.postMessage({ type: "need-token" }, [ch.port2]);
  });
}
async function currentToken(clientId) {
  if (token) return token;
  const targets = [];
  if (clientId) {
    const c = await self.clients.get(clientId);
    if (c) targets.push(c);
  }
  if (!targets.length) targets.push(...await self.clients.matchAll({ type: "window" }));
  for (const c of targets) {
    const t = await askToken(c);
    if (t) { token = t; return t; }
  }
  return null;
}

const STREAM_RE = /\/stream\/([^/?]+)$/;

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  const m = url.pathname.match(STREAM_RE);
  if (!m) return;   // 우리 몫이 아니면 손대지 않는다 — 나머지는 그냥 통과시킨다

  const fileId = decodeURIComponent(m[1]);
  const size = Number(url.searchParams.get("size")) || 0;
  event.respondWith(handleStream(fileId, size, event.request, event.clientId));
});

/* "bytes=0-1", "bytes=1048576-"(끝까지), "bytes=-500"(마지막 500바이트) 형태를 파싱한다.
   비디오 엔진이 보내는 요청은 거의 항상 이 세 형태 중 하나다. */
function parseRange(rangeHeader, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader || "");
  if (!m || (!m[1] && !m[2])) return null;
  let start = m[1] === "" ? null : parseInt(m[1], 10);
  let end = m[2] === "" ? null : parseInt(m[2], 10);
  if (start === null) {
    start = Math.max(0, size - end);
    end = size - 1;
  } else if (end === null || end >= size) {
    end = size - 1;
  }
  if (start > end) return null;
  return { start, end };
}

async function handleStream(fileId, size, request, clientId) {
  const tok = await currentToken(clientId);
  if (!tok) {
    return new Response("스트리밍용 인증 토큰이 없습니다. 페이지에서 Google 계정을 다시 연결해 주세요.", { status: 401 });
  }

  const headers = { Authorization: "Bearer " + tok };
  const range = request.headers.get("Range");
  if (range) headers.Range = range;

  let upstream;
  try {
    upstream = await fetch(
      "https://www.googleapis.com/drive/v3/files/" + encodeURIComponent(fileId) + "?alt=media",
      { headers }
    );
  } catch (err) {
    return new Response("업스트림 요청 실패: " + err.name + ": " + err.message, { status: 502 });
  }

  /* 만료·철회된 토큰은 버린다 — 다음 요청 때 페이지에 새 토큰을 다시 묻게 된다 */
  if (upstream.status === 401 && token === tok) token = null;

  const outHeaders = new Headers();
  const contentType = upstream.headers.get("content-type");
  if (contentType) outHeaders.set("content-type", contentType);
  outHeaders.set("accept-ranges", "bytes");

  let status = upstream.status;

  /* 구글이 실제로 부분 응답(206)을 줬을 때만 Content-Range를 직접 계산해 붙인다 —
     200(범위 무시하고 전체를 줌)이면 거짓으로 206이라 하지 않고 그대로 통과시킨다. */
  if (upstream.status === 206 && range && size > 0) {
    const parsed = parseRange(range, size);
    if (parsed) {
      status = 206;
      outHeaders.set("content-range", "bytes " + parsed.start + "-" + parsed.end + "/" + size);
      outHeaders.set("content-length", String(parsed.end - parsed.start + 1));
    }
  }
  if (!outHeaders.has("content-length")) {
    const cl = upstream.headers.get("content-length");
    if (cl) outHeaders.set("content-length", cl);
    else if (size > 0 && status === 200) outHeaders.set("content-length", String(size));
  }

  return new Response(upstream.body, {
    status: status,
    statusText: upstream.statusText,
    headers: outHeaders
  });
}
