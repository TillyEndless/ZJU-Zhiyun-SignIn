import { CLASSROOM, COURSES, ZJUAM } from "login-zju";
import { v4 as uuidv4 } from "uuid";
import dotenv from "dotenv";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import dingTalk from "../shared/dingtalk-webhook.js";
import Decimal from "decimal.js";
Decimal.set({ precision: 100 });

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// 无论从哪级目录启动，优先加载仓库根目录 .env（避免 ZJU_PASSWORD 未注入导致 login-zju 报 n is not iterable）
dotenv.config({ path: path.join(__dirname, "..", ".env") });
dotenv.config();

const zjuUser = (process.env.ZJU_USERNAME ?? "").trim();
const zjuPass = process.env.ZJU_PASSWORD;
if (!zjuUser || zjuPass === undefined || zjuPass === null || String(zjuPass) === "") {
  console.error(
    "[Auto Sign-in] 缺少 ZJU_USERNAME 或 ZJU_PASSWORD。请检查仓库根目录 .env，并从项目根执行：\n" +
      "  node courses.zju/autosign.js"
  );
  process.exit(1);
}
const EVENT_LOG_PATH =
  process.env.AUTOSIGN_EVENT_LOG || path.join(__dirname, "autosign-events.log");

function appendEventLog(line) {
  try {
    fs.appendFileSync(
      EVENT_LOG_PATH,
      `[${new Date().toISOString()}] ${line}\n`,
      "utf8"
    );
  } catch (_e) {
    /* ignore disk errors */
  }
}

/** 签到相关：钉钉 + 控制台 + 本地日志（tmux 刷屏丢记录时可查此文件） */
function signNotify(msg) {
  appendEventLog(msg.replace(/\n/g, " | "));
  console.log(msg);
  dingTalk(msg);
}

const CONFIG = {
  raderAt: "ZJGD1",
  coldDownTime: 1500, // 1.5s
  transcriptDebugIntervalMs: Number(process.env.DEBUG_TRANSCRIPT_INTERVAL_MS || 8000),
  /** 无点名时终端心跳间隔（毫秒）。0 = 不在终端打印「No rollcalls」 */
  emptyConsoleLogIntervalMs: Number(
    process.env.AUTOSIGN_EMPTY_CONSOLE_MS ?? 60_000
  ),
};
const RaderInfo = {
  ZJGD1: [120.089136, 30.302331], //东一教学楼
  ZJGX1: [120.085042, 30.30173], //西教学楼
  ZJGB1: [120.077135, 30.305142], //段永平教学楼
  YQ4: [120.122176,30.261555], //玉泉教四
  YQ1: [120.123853,30.262544], //玉泉教一
  YQ7: [120.120344,30.263907], //玉泉教七
  ZJ1: [120.126008,30.192908], //之江校区1
  HJC1: [120.195939,30.272068], //华家池校区1
  HJC2: [120.198193,30.270419], //华家池校区2
  ZJ2: [120.124267,30.19139], //之江校区2 // 之江校区半径都没500米
  YQSS: [120.124001,30.265735], //虽然大概不会有课在宿舍上但还是放一个点位
  ZJG4: [120.073427,30.299757], //紫金港大西区
};
// 说明: 在这里配置签到地点后，签到会优先【使用配置的地点】尝试
//      随后会尝试遍历RaderInfo中的所有地点
//      如果失败了>3次，则会尝试三点定位法

// 成功率：目前【雷达点名】+【已配置了雷达地点】的情况可以100%签到成功
//        数字点名已测试，已成功，确定远程没有限速，没有calm down，但是目前单线程，可能会有点慢，
//        三点定位法已完成，感谢@eWloYW8

// 顺便一提，经测试，rader_out_of_scope的限制是500米整

const sendBoth=(msg)=>{
  console.log(msg);
  dingTalk(msg);
}

const formatApiTime = (value) => {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleString("zh-CN", { hour12: false });
};

const buildRollcallTimeHint = (rollcall) => {
  const startCandidate =
    rollcall?.rollcall_time ||
    rollcall?.published_at ||
    rollcall?.start_at ||
    rollcall?.created_at ||
    "";
  const endCandidate =
    rollcall?.end_at ||
    rollcall?.expire_at ||
    rollcall?.expired_at ||
    rollcall?.deadline_at ||
    "";

  const startText = formatApiTime(startCandidate);
  const endText = formatApiTime(endCandidate);

  if (startText && endText) {
    return `签到时间范围：${startText} ~ ${endText}`;
  }
  if (startText) {
    return `签到开始时间：${startText}（结束时间未返回）`;
  }
  if (endText) {
    return `签到结束时间：${endText}（开始时间未返回）`;
  }
  if (rollcall?.is_expired === true) {
    return "签到时间范围：该签到已过期（接口未返回具体时间）";
  }
  return "签到时间范围：接口未返回";
};

const buildRollcallCourseHint = (rollcall) => {
  const parts = [];
  if (rollcall?.course_id != null && rollcall.course_id !== "")
    parts.push(`course_id=${rollcall.course_id}`);
  if (rollcall?.class_name)
    parts.push(`班级=${rollcall.class_name}`);
  if (rollcall?.grade_name)
    parts.push(`年级=${rollcall.grade_name}`);
  return parts.length ? `（${parts.join("，")}）` : "";
};


const courses = new COURSES(new ZJUAM(zjuUser, String(zjuPass)));
const classroom = new CLASSROOM(new ZJUAM(zjuUser, String(zjuPass)));

appendEventLog("autosign started");
sendBoth("[Auto Sign-in] Started. Waiting for courses login...");
let loginNotified = false;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let req_num = 0;

let we_are_bruteforcing = [];
/** 避免同一 rollcall 每轮轮询重复发「开始签到」钉钉 */
const radarNotifySent = new Set();
/** 避免同一 rollcall 并发多次 answerRaderRollcall */
const radarAnswerInFlight = new Set();
const radarFailureNotified = new Set();
const radarSuccessNotified = new Set();
const alreadyOnCallNotified = new Set();
let lastFetchRollcallsErrorDingAt = 0;
let lastRollcallIdsKey = "";
let lastEmptyConsoleLogAt = 0;

if (process.env.DEBUG_TRANSCRIPT === "true") {
  startTranscriptDebugLoop();
}

// if (false)
(async () => {
  while (true) {
    await courses
      .fetch("https://courses.zju.edu.cn/api/radar/rollcalls")
      .then((v) => v.text())
      .then(async (fa) => {
        try {
          return JSON.parse(fa);
        } catch (e) {
          signNotify(
            "[-][Auto Sign-in] 点名接口返回非 JSON: " +
              fa.slice(0, 400) +
              (fa.length > 400 ? "…" : "") +
              "\nError: " +
              e.toString()
          );
          return null;
        }
      })
  //     .then((v) => v.json())
      .then(async (v) => {
        if (!v || !Array.isArray(v.rollcalls)) {
          console.log(`[Auto Sign-in](Req #${++req_num}) Invalid rollcalls response, skip.`);
          return;
        }
        if (!loginNotified) {
          signNotify("[Auto Sign-in] Logged in as " + zjuUser);
          loginNotified = true;
        }
        req_num++;
        if (v.rollcalls.length == 0) {
          const now = Date.now();
          const iv = CONFIG.emptyConsoleLogIntervalMs;
          if (iv > 0 && now - lastEmptyConsoleLogAt > iv) {
            lastEmptyConsoleLogAt = now;
            console.log(
              `[Auto Sign-in](Req #${req_num}) No rollcalls（终端约每 ${Math.round(iv / 1000)}s 提示一次；签到见钉钉与 ${EVENT_LOG_PATH}）`
            );
          }
        } else {
          console.log(
            `[Auto Sign-in](Req #${req_num}) Found ${v.rollcalls.length} rollcalls.`
          );
          const idsKey = v.rollcalls
            .map((r) => r.rollcall_id)
            .sort()
            .join(",");
          if (idsKey !== lastRollcallIdsKey) {
            lastRollcallIdsKey = idsKey;
            const summary = v.rollcalls
              .map((rc) => {
                const hint = buildRollcallCourseHint(rc);
                const kind =
                  rc.is_radar || rc.source === "radar"
                    ? "雷达"
                    : rc.is_number
                      ? "数字"
                      : "未知类型";
                return `· #${rc.rollcall_id} ${kind} ${rc.course_title || ""}${hint} status=${rc.status ?? ""}/${rc.status_name ?? ""}`;
              })
              .join("\n");
            signNotify(
              `[签到检测] 学在浙大当前返回 ${v.rollcalls.length} 条点名，请及时处理：\n${summary}`
            );
          }

          v.rollcalls.forEach((rollcall) => {
            /**
             * It looks like 
             * 
  {
    avatar_big_url: '',
    class_name: '',
    course_id: 77997,
    course_title: '思想道德与法治',
    created_by: 1835,
    created_by_name: '单珏慧',
    department_name: '马克思主义学院',
    grade_name: '',
    group_set_id: 0,
    is_expired: false,
    is_number: false,
    is_radar: true,
    published_at: null,
    rollcall_id: 171329,
    rollcall_status: 'in_progress',
    rollcall_time: '2024-12-12T10:51:43Z',
    scored: true,
    source: 'radar',
    status: 'absent',
    student_rollcall_id: 0,
    title: '2024.12.12 18:51',
    type: 'another'
  }
             */
            const rollcallId = rollcall.rollcall_id;
            // console.log(rollcall);
            if (rollcall.status == "on_call_fine" || rollcall.status == "on_call" || rollcall.status_name == "on_call_fine" || rollcall.status_name == "on_call") {
              if (!alreadyOnCallNotified.has(rollcallId)) {
                alreadyOnCallNotified.add(rollcallId);
                const hint = buildRollcallCourseHint(rollcall);
                signNotify(
                  `[签到状态] 点名 #${rollcallId} 已显示为已签到（on_call），无需再签。${rollcall.course_title || ""}${hint}`
                );
              }
              return;
            }
            console.log("[Auto Sign-in] Now answering rollcall #" + rollcallId);
            let handled = false;
            const isRadar =
              rollcall.is_radar === true || rollcall.source === "radar";
            if (isRadar) {
              handled = true;
              const timeHint = buildRollcallTimeHint(rollcall);
              const courseHint = buildRollcallCourseHint(rollcall);
              if (!radarNotifySent.has(rollcallId)) {
                radarNotifySent.add(rollcallId);
                signNotify(
                  `[Auto Sign-in] 开始自动雷达签到 #${rollcallId}: ${rollcall.title} @ ${rollcall.course_title} by ${rollcall.created_by_name} (${rollcall.department_name})${courseHint}\n${timeHint}`
                );
              }
              if (!radarAnswerInFlight.has(rollcallId)) {
                radarAnswerInFlight.add(rollcallId);
                answerRaderRollcall(RaderInfo[CONFIG.raderAt], rollcallId)
                  .then((ok) => {
                    if (ok && !radarSuccessNotified.has(rollcallId)) {
                      radarSuccessNotified.add(rollcallId);
                      signNotify(
                        `[Auto Sign-in] 雷达签到成功 #${rollcallId} ${rollcall.course_title || ""}${courseHint}`
                      );
                    }
                    if (!ok && !radarFailureNotified.has(rollcallId)) {
                      radarFailureNotified.add(rollcallId);
                      signNotify(
                        `[Auto Sign-in] Radar rollcall #${rollcallId} 自动签到失败（已尝试配置点、全部信标与三点定位）。请检查 CONFIG.raderAt 是否匹配教室，或手动签到。${courseHint}\n${timeHint}`
                      );
                    }
                  })
                  .catch((err) => {
                    signNotify(
                      `[Auto Sign-in] Radar rollcall #${rollcallId} 签到过程异常: ${err?.message || err}${courseHint}`
                    );
                  })
                  .finally(() => {
                    radarAnswerInFlight.delete(rollcallId);
                  });
              }
            }
            if (rollcall.is_number) {
              handled = true;
              if(we_are_bruteforcing.includes(rollcallId)){
                console.log("[Auto Sign-in] We are already bruteforcing rollcall #" + rollcallId);
                return;
              }
              we_are_bruteforcing.push(rollcallId);
              const timeHint = buildRollcallTimeHint(rollcall);
              const courseHint = buildRollcallCourseHint(rollcall);
              signNotify(
                `[Auto Sign-in] 开始数字点名爆破 #${rollcallId}: ${rollcall.title} @ ${rollcall.course_title} by ${rollcall.created_by_name} (${rollcall.department_name})${courseHint}\n${timeHint}`
              );
              batchNumberRollCall(rollcallId, courseHint);
            }
            if (!handled) {
              const detail = JSON.stringify(rollcall);
              const snippet =
                detail.length > 1200 ? detail.slice(0, 1200) + "…" : detail;
              signNotify(
                `[Auto Sign-in] Rollcall #${rollcallId} 类型未知，无法自动处理，请手动签到。${buildRollcallCourseHint(rollcall)}\n${snippet}`
              );
              console.log(
                `[Auto Sign-in] Rollcall #${rollcallId} has an unknown type and we cannot handle it yet.`
              );
            }
          });
        }
      }).catch((e) => {
        console.log(
          `[Auto Sign-in](Req #${++req_num}) Failed to fetch rollcalls: `,
          e
        );
        const now = Date.now();
        if (now - lastFetchRollcallsErrorDingAt > 5 * 60 * 1000) {
          lastFetchRollcallsErrorDingAt = now;
          const msg = String(e?.message || e);
          const iterableHint = msg.includes("is not iterable")
            ? " 常见原因：未加载到 ZJU_PASSWORD（login-zju 加密密码时崩溃）。请确认仓库根目录存在 .env 且含密码，或从项目根执行 node courses.zju/autosign.js。"
            : "";
          signNotify(
            `[Auto Sign-in] 拉取点名列表失败: ${msg}（5 分钟内同类告警已合并）${iterableHint}`
          );
        }
      });

    await sleep(CONFIG.coldDownTime);
  }
})();

function decimalHaversineDist(lon, lat, lon_i, lat_i, R) {
  const DEG = Decimal.acos(-1).div(180);

  const λ  = new Decimal(lon).mul(DEG);
  const φ  = new Decimal(lat).mul(DEG);
  const λi = new Decimal(lon_i).mul(DEG);
  const φi = new Decimal(lat_i).mul(DEG);

  const dφ = φ.minus(φi);
  const dλ = λ.minus(λi);

  const sin_dφ_2 = dφ.div(2).sin().pow(2);
  const sin_dλ_2 = dλ.div(2).sin().pow(2);

  const h = sin_dφ_2.plus(
    φ.cos().mul(φi.cos()).mul(sin_dλ_2)
  );

  const deltaSigma = Decimal.asin(h.sqrt()).mul(2);

  return R.mul(deltaSigma);
}

function residualsDecimal(lon, lat, pts, R) {
  const res = [];

  for (const p of pts) {
    const dist = decimalHaversineDist(lon, lat, p.lon, p.lat, R);
    res.push(new Decimal(p.d).minus(dist));
  }
  return res;
}

function jacobianDecimal(lon, lat, pts, R) {
  const eps = new Decimal("1e-12");

  const base = residualsDecimal(lon, lat, pts, R);

  const resLon = residualsDecimal(
    new Decimal(lon).plus(eps),
    lat,
    pts,
    R
  );
  const resLat = residualsDecimal(
    lon,
    new Decimal(lat).plus(eps),
    pts,
    R
  );

  const J = [];
  for (let i = 0; i < pts.length; i++) {
    const dLon = resLon[i].minus(base[i]).div(eps).neg();
    const dLat = resLat[i].minus(base[i]).div(eps).neg();
    J.push([dLon, dLat]);
  }
  return J;
}

function gaussNewtonDecimal(pts, lon0, lat0, R) {
  let lon = new Decimal(lon0);
  let lat = new Decimal(lat0);

  for (let iter = 0; iter < 30; iter++) {
    const r = residualsDecimal(lon, lat, pts, R);
    const J = jacobianDecimal(lon, lat, pts, R);

    let JTJ = [
      [new Decimal(0), new Decimal(0)],
      [new Decimal(0), new Decimal(0)]
    ];
    let JTr = [new Decimal(0), new Decimal(0)];

    for (let i = 0; i < pts.length; i++) {
      const j = J[i];
      const ri = r[i];

      JTJ[0][0] = JTJ[0][0].plus(j[0].mul(j[0]));
      JTJ[0][1] = JTJ[0][1].plus(j[0].mul(j[1]));
      JTJ[1][0] = JTJ[1][0].plus(j[1].mul(j[0]));
      JTJ[1][1] = JTJ[1][1].plus(j[1].mul(j[1]));

      JTr[0] = JTr[0].plus(j[0].mul(ri));
      JTr[1] = JTr[1].plus(j[1].mul(ri));
    }

    const det = JTJ[0][0].mul(JTJ[1][1]).minus(
      JTJ[0][1].mul(JTJ[1][0])
    );

    const inv = [
      [
        JTJ[1][1].div(det),
        JTJ[0][1].neg().div(det)
      ],
      [
        JTJ[1][0].neg().div(det),
        JTJ[0][0].div(det)
      ]
    ];

    const dLon = inv[0][0].mul(JTr[0]).plus(inv[0][1].mul(JTr[1]));
    const dLat = inv[1][0].mul(JTr[0]).plus(inv[1][1].mul(JTr[1]));

    lon = lon.plus(dLon);
    lat = lat.plus(dLat);

    console.log(`[Iter ${iter}] lon = ${lon}, lat = ${lat}`);

    // 收敛条件
    if (dLon.abs().lt("1e-14") && dLat.abs().lt("1e-14")) break;
  }

  return { lon, lat };
}

function rmsDecimal(lon, lat, pts, R) {
  let sum = new Decimal(0);

  for (const p of pts) {
    const dModel = decimalHaversineDist(lon, lat, p.lon, p.lat, R);
    const diff = new Decimal(p.d).minus(dModel);
    sum = sum.plus(diff.mul(diff));
  }

  return sum.div(pts.length).sqrt(); 
}

function solveSphereLeastSquaresDecimal(rawPoints) {

  const lon0 = rawPoints.reduce((s,p)=>s+p.lon,0) / rawPoints.length;
  const lat0 = rawPoints.reduce((s,p)=>s+p.lat,0) / rawPoints.length;

  const R = new Decimal("6372999.26");

  const res = gaussNewtonDecimal(rawPoints, lon0, lat0, R);

  const rms = rmsDecimal(res.lon, res.lat, rawPoints, R);

  return {
    lon: Number(res.lon),
    lat: Number(res.lat),
    rms: Number(rms)
  };
}


async function answerRaderRollcall(raderXY, rid) {

  async function _req(lon, lat) {
    return await courses.fetch(
      "https://courses.zju.edu.cn/api/rollcall/" + rid + "/answer?api_version=1.1.2",
      {
        body: JSON.stringify({
          deviceId: uuidv4(),
          latitude: lat,
          longitude: lon,
          speed: null,
          accuracy: 68,
          altitude: null,
          altitudeAccuracy: null,
          heading: null,
        }),
        method: "PUT",
        headers: { "Content-Type": "application/json" }
      }
    ).then(async v => {
      try { return await v.json(); }
      catch (e) { console.log("[Autosign][JSON error]", e); return null; }
    });
  }

  let rader_outcome = [];

  // Step 1: try configured location
  if (raderXY) {
    const outcome = await _req(raderXY[0], raderXY[1]);
    console.log("[Autosign][Try Config]", raderXY, outcome);
    if (outcome?.status_name === "on_call_fine") return true;
    rader_outcome.push([raderXY, outcome]);
  }

  // Step 2: try all radar beacon points
  for (const [key, value] of Object.entries(RaderInfo)) {
    const outcome = await _req(value[0], value[1]);
    console.log("[Autosign][Try Beacon]", key, value, outcome);

    if (outcome?.status_name === "on_call_fine") return true;
    rader_outcome.push([value, outcome]);
  }

  // Step 3: spherical Nelder-Mead trilateration
  let rawPoints = [];

  for (const [coord, outcome] of rader_outcome) {
    const d = Number(outcome?.distance ?? outcome?.data?.distance ?? outcome?.result?.distance);
    if (Number.isFinite(d) && d > 0) {
      rawPoints.push({ lon: coord[0], lat: coord[1], d });
      console.log("[Autosign][Dist Point]", coord, "d =", d);
    }
  }

  if (rawPoints.length < 3) {
    console.log("[Autosign][SphereFit] Not enough points.");
    return false;
  }

  const est = solveSphereLeastSquaresDecimal(rawPoints);

  console.log("[Autosign][SphereFit] Estimated:", est);

  const finalOutcome = await _req(est.lon, est.lat);

  if (finalOutcome?.status_name === "on_call_fine") {
    console.log(
      "[Autosign] SphereFit success",
      est.lon,
      est.lat
    );
    return true;
  }

  return false;
}

async function getCurrentClassroomSession() {
  const res = await classroom.fetch(
    "https://education.cmc.zju.edu.cn/personal/courseapi/vlabpassportapi/v1/account-profile/course?nowpage=1&per-page=100&force_mycourse=1"
  );
  const data = await res.json();
  const courseList = data?.params?.result?.data || [];

  for (const c of courseList) {
    const catRes = await classroom.fetch(
      "https://yjapi.cmc.zju.edu.cn/courseapi/v2/course/catalogue?course_id=" + c.Id
    );
    const catData = await catRes.json();
    const live = (catData?.result?.data || []).find((v) => v.status === "1");
    if (live) {
      let content = {};
      try {
        content = JSON.parse(live.content || "{}");
      } catch (_e) {
        content = {};
      }
      return {
        courseId: c.Id,
        courseTitle: c.Title,
        teacher: c.Teacher,
        subId: live.sub_id,
        subTitle: live.title,
        transSocketUrl: content.trans_socket_url || "",
      };
    }
  }
  return null;
}

async function fetchLatestTranscriptLine(subId) {
  const res = await classroom.fetch(
    `https://yjapi.cmc.zju.edu.cn/courseapi/v3/web-socket/search-trans-result?sub_id=${subId}&format=json`
  );
  const data = await res.json();
  const list = data?.list || [];
  let latest = null;
  for (const item of list) {
    for (const c of item?.all_content || []) {
      const text = (c?.Text || "").trim();
      if (!text) continue;
      const beginSec = Number(c?.BeginSec || 0);
      if (!latest || beginSec >= latest.beginSec) {
        latest = { beginSec, text };
      }
    }
  }
  return latest;
}

async function startTranscriptDebugLoop() {
  sendBoth("[Transcript Debug] Enabled. Looking for active classroom session...");
  let currentSubId = "";
  let lastTranscript = "";
  let lastNoTranscriptLogAt = 0;

  while (true) {
    try {
      const session = await getCurrentClassroomSession();
      if (!session) {
        console.log("[Transcript Debug] No active classroom session.");
      } else {
        if (session.subId !== currentSubId) {
          currentSubId = session.subId;
          lastTranscript = "";
          sendBoth(
            `[Transcript Debug] Active: ${session.courseTitle} - ${session.subTitle} @ ${session.teacher} (sub_id=${session.subId})`
          );
          console.log(`[Transcript Debug] trans_socket_url: ${session.transSocketUrl || "<empty>"}`);
        }

        const latest = await fetchLatestTranscriptLine(session.subId);
        if (latest?.text && latest.text !== lastTranscript) {
          lastTranscript = latest.text;
          console.log(`[Transcript Debug] ${latest.text}`);
        } else if (!latest?.text) {
          const now = Date.now();
          if (now - lastNoTranscriptLogAt > 30000) {
            lastNoTranscriptLogAt = now;
            console.log("[Transcript Debug] Active session found, but no transcript text yet.");
          }
        }
      }
    } catch (e) {
      console.log("[Transcript Debug] Error:", e?.message || e);
    }
    await sleep(CONFIG.transcriptDebugIntervalMs);
  }
}

async function answerNumberRollcall(numberCode, rid) {
  return await courses
    .fetch(
      "https://courses.zju.edu.cn/api/rollcall/" +
      rid +
      "/answer_number_rollcall",
      {
        body: JSON.stringify({
          deviceId: uuidv4(),
          numberCode,
        }),
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          // "X-Session-Id": courses.session,
        },
      }
    )
    .then(async(vd) => {
      // console.log(vd.status, vd.statusText);
      // console.log(await vd.text());
      /*
      When fail:
      400 BAD REQUEST
      {"error_code":"wrong_number_code","message":"wrong number code","number_code":"6921"}
      When success:
      200 OK
      {"id":5427153,"status":"on_call"}

       */

      
      if (vd.status != 200 || vd.error_code?.includes("wrong")) {
        return false;
      }
      return true;
    });
}

let currentBatchingRCs = [];
async function batchNumberRollCall(rid, courseHint = "") {
  if (currentBatchingRCs.includes(rid)) return;

  currentBatchingRCs.push(rid);

  const state = new Map();
  state.set("found", false);

  const batchSize = 200;
  let foundCode = null;

  for (let start = 0; start <= 9999; start += batchSize) {

    if (state.get("found")) break;

    const end = Math.min(start + batchSize - 1, 9999);
    const tasks = [];

    for (let ckn = start; ckn <= end; ckn++) {
      const code = ckn.toString().padStart(4, "0");

      tasks.push(
        answerNumberRollcall(code, rid).then(success => {
          if (state.get("found")) return;

          if (success) {
            foundCode = code;
            state.set("found", true);
          }
        })
      );
    }

    await Promise.race([
      Promise.all(tasks),
      new Promise(resolve => {
        const timer = setInterval(() => {
          if (state.get("found")) {
            clearInterval(timer);
            resolve();
          }
        }, 20);
      })
    ]);

    if (state.get("found")) break;
  }

  if (foundCode) {
    signNotify(
      `[Auto Sign-in] 数字点名成功 #${rid}，口令 ${foundCode}${courseHint}`
    );
  }
  else {
    signNotify(
      `[Auto Sign-in] 数字点名失败 #${rid}（未试出有效口令）${courseHint}`
    );
  }
}

