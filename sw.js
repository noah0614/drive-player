/* Google Drive Player — 스트리밍 프록시 서비스워커.
   <video>/<audio> 태그는 커스텀 HTTP 헤더(Authorization)를 실을 방법이 없다.
   Drive API로 원본 바이트를 받으려면 이 헤더가 필수라서, 같은 출처의
   "stream/<fileId>" 요청을 여기서 가로채 Authorization을 붙여 Drive API로
   대신 요청하고, 그 응답(Range 지원 포함)을 그대로 돌려준다.
   이렇게 하면 브라우저의 video 엔진이 평소처럼 Range 요청을 날리며 진짜
   스트리밍·탐색을 하고, 페이지 JS가 파일 전체를 메모리에 들고 있지 않아도 된다. */

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

const STREAM_RE = /\/stream\/([^/?]+)$/;

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  const m = url.pathname.match(STREAM_RE);
  if (!m) return;   // 우리 몫이 아니면 손대지 않는다 — 나머지는 그냥 통과시킨다

  event.respondWith(handleStream(decodeURIComponent(m[1]), event.request));
});

async function handleStream(fileId, request) {
  if (!token) {
    return new Response("스트리밍용 인증 토큰이 아직 없습니다. 페이지를 새로고침해 보세요.", { status: 401 });
  }

  const headers = { Authorization: "Bearer " + token };
  const range = request.headers.get("Range");
  if (range) headers.Range = range;

  let upstream;
  try {
    upstream = await fetch(
      "https://www.googleapis.com/drive/v3/files/" + encodeURIComponent(fileId) + "?alt=media",
      { headers }
    );
  } catch (err) {
    return new Response("업스트림 요청 실패: " + err.message, { status: 502 });
  }

  /* Range 탐색에 필요한 헤더만 그대로 옮긴다 — Drive가 이미 Content-Range/206을 내려준다. */
  const outHeaders = new Headers();
  for (const key of ["content-type", "content-length", "content-range", "accept-ranges", "etag", "last-modified"]) {
    const v = upstream.headers.get(key);
    if (v) outHeaders.set(key, v);
  }
  if (!outHeaders.has("accept-ranges")) outHeaders.set("accept-ranges", "bytes");

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: outHeaders
  });
}
