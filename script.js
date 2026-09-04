// Firebase / Google 로그인
// ============================================================

import { initializeApp } from "https://www.gstatic.com/firebasejs/12.8.0/firebase-app.js";
import {
    getAuth,
    GoogleAuthProvider,
    onAuthStateChanged,
    setPersistence,
    browserLocalPersistence,
    browserSessionPersistence,
    inMemoryPersistence,
    signInWithPopup,
    signOut
} from "https://www.gstatic.com/firebasejs/12.8.0/firebase-auth.js";
import {
    getFirestore,
    doc,
    getDoc,
    setDoc,
    serverTimestamp
} from "https://www.gstatic.com/firebasejs/12.8.0/firebase-firestore.js";
import {
    getMessaging,
    getToken,
    onMessage
} from "https://www.gstatic.com/firebasejs/12.8.0/firebase-messaging.js";

const firebaseConfig = {
    apiKey: "AIzaSyBF-wTk14lNmZlOKuwrwjZLN3vpVZPyAyM",
    authDomain: "my-dashboard-2b50f.firebaseapp.com",
    projectId: "my-dashboard-2b50f",
    storageBucket: "my-dashboard-2b50f.firebasestorage.app",
    messagingSenderId: "966095927988",
    appId: "1:966095927988:web:14f81692ddb4255f1835e1"
};

const firebaseApp = initializeApp(firebaseConfig);
const auth = getAuth(firebaseApp);
const db = getFirestore(firebaseApp);
const googleProvider = new GoogleAuthProvider();
let messaging = null;

// Firebase 콘솔의 Project settings > Cloud Messaging > Web Push certificates에서
// Web Push 인증서의 공개 키(VAPID public key)를 발급받아 이 값에 넣어주세요.
const TODO_ALARM_VAPID_KEY = "BHmtqG5VzPik-yvduK5SXku68vQ2v5XykfsHVbXp3RFdk2GMXRCSM7XG-6DR4-eSlHqJS-ou_VTgGUqHKv8iYqs";

// ------------------------------------------------------------
// 모바일 브라우저 판별
// ------------------------------------------------------------
// PC에서 정상 동작하는 인증 흐름은 그대로 두고,
// Android / iPhone / iPad 계열에서는 인증 저장소와
// 로그인 후 동기화의 실패 처리를 더 보수적으로 한다.
const isMobileBrowser = /Android|iPhone|iPad|iPod/i.test(
    navigator.userAgent || ""
);

// ------------------------------------------------------------
// 인증 저장소
// ------------------------------------------------------------
// PC: 기존 local persistence 유지
// 모바일: 삼성 인터넷 등에서 local persistence가 불안정한 경우를
// 피하기 위해 session -> memory 순서로 안전하게 내려간다.
const authPersistenceReady = (async function () {
    if (isMobileBrowser) {
        try {
            await setPersistence(auth, browserSessionPersistence);
            console.log("모바일 인증: session persistence 사용");
            return true;
        } catch (sessionError) {
            console.warn(
                "모바일 session persistence 실패. memory persistence로 전환합니다.",
                sessionError
            );

            try {
                await setPersistence(auth, inMemoryPersistence);
                console.log("모바일 인증: memory persistence 사용");
                return true;
            } catch (memoryError) {
                console.error(
                    "모바일 Firebase persistence 설정 실패:",
                    memoryError
                );
                return false;
            }
        }
    }

    try {
        await setPersistence(auth, browserLocalPersistence);
        console.log("PC 인증: local persistence 사용");
        return true;
    } catch (localError) {
        console.warn(
            "browserLocalPersistence 실패. session persistence로 전환합니다.",
            localError
        );

        try {
            await setPersistence(auth, browserSessionPersistence);
            return true;
        } catch (sessionError) {
            console.warn(
                "browserSessionPersistence도 실패. memory persistence로 전환합니다.",
                sessionError
            );

            try {
                await setPersistence(auth, inMemoryPersistence);
                return true;
            } catch (memoryError) {
                console.error(
                    "Firebase 로그인 persistence 설정 실패:",
                    memoryError
                );
                return false;
            }
        }
    }
})();

let currentFirebaseUser = null;
let cloudSyncReady = false;
let authHandling = false;
let authOperationId = 0;
let cloudHydrating = false;
let activeSyncPromise = null;
let activeSyncUid = null;

let todoAlarmSettings = loadFromStorage("todoAlarmSettings", {
    enabled: false,
    times: []
});
let todoAlarmServiceWorkerRegistration = null;

const CLOUD_KEYS = [
    "categories",
    "projects",
    "memos",
    "schedules",
    "dDays",
    "studyRecords",
    "dailyStudyGoal",
    "todoAlarmSettings"
];

const authScreen = document.getElementById("authScreen");
const googleLoginButton = document.getElementById("googleLoginButton");
const authMessage = document.getElementById("authMessage");
const accountUserName = document.getElementById("accountUserName");
const logoutButton = document.getElementById("logoutButton");

function setAuthMessage(message) {
    if (authMessage) {
        authMessage.textContent = message || "";
    }
}

function lockDashboard() {
    document.body.classList.add("auth-locked");
}

function unlockDashboard() {
    document.body.classList.remove("auth-locked");
}

// 최초 인증 상태가 확정되기 전에는 앱을 잠근다.
lockDashboard();
setAuthMessage("로그인 상태를 확인하는 중...");

// ------------------------------------------------------------
// Firestore 저장
// ------------------------------------------------------------
// 핵심:
// 로그인 직후 로컬 데이터를 Firestore에 먼저 쓰면
// 모바일의 오래된 Todo가 PC의 최신 Todo를 덮어쓸 수 있다.
// 따라서 클라우드 동기화가 완료되기 전에는 일반 저장을 금지한다.
async function saveCloudData(key, data, force = false) {
    if (!currentFirebaseUser) {
        return false;
    }

    if (!force && (!cloudSyncReady || cloudHydrating)) {
        return false;
    }

    const userAtStart = currentFirebaseUser;

    try {
        await setDoc(
            doc(
                db,
                "users",
                userAtStart.uid,
                "data",
                key
            ),
            {
                value: data,
                updatedAt: serverTimestamp()
            }
        );

        return true;
    } catch (error) {
        console.error(`Firebase 저장 실패 (${key})`, error);
        return false;
    }
}

function withTimeout(promise, ms, label) {
    let timeoutId = null;

    const timeoutPromise = new Promise(function (_, reject) {
        timeoutId = setTimeout(function () {
            reject(new Error(label + " 시간 초과"));
        }, ms);
    });

    return Promise.race([
        promise,
        timeoutPromise
    ]).finally(function () {
        if (timeoutId !== null) {
            clearTimeout(timeoutId);
        }
    });
}

async function getCloudData(key, user) {
    const targetUser = user || currentFirebaseUser;

    if (!targetUser) {
        return {
            ok: false,
            exists: false,
            value: null,
            error: new Error("로그인 사용자가 없습니다.")
        };
    }

    try {
        const snapshot = await withTimeout(
            getDoc(
                doc(
                    db,
                    "users",
                    targetUser.uid,
                    "data",
                    key
                )
            ),
            3500,
            "Firestore 읽기"
        );

        if (!snapshot.exists()) {
            return {
                ok: true,
                exists: false,
                value: null,
                error: null
            };
        }

        return {
            ok: true,
            exists: true,
            value: snapshot.data().value,
            error: null
        };
    } catch (error) {
        return {
            ok: false,
            exists: false,
            value: null,
            error: error
        };
    }
}

function getLocalDataForCloud(key) {
    if (key === "dailyStudyGoal") {
        return Number(localStorage.getItem("dailyStudyGoal")) || 3600;
    }

    return loadFromStorage(key, []);
}

function setLocalDataFromCloud(key, value) {
    if (key === "dailyStudyGoal") {
        localStorage.setItem(
            "dailyStudyGoal",
            String(Number(value) || 3600)
        );
        return;
    }

    localStorage.setItem(
        key,
        JSON.stringify(value)
    );
}

function setLocalDataEmpty(key) {
    if (key === "dailyStudyGoal") {
        localStorage.setItem("dailyStudyGoal", "3600");
        return;
    }

    localStorage.setItem(
        key,
        JSON.stringify([])
    );
}

async function uploadAllLocalData(user) {
    const targetUser = user || currentFirebaseUser;

    if (!targetUser) {
        return false;
    }

    let allSucceeded = true;

    for (const key of CLOUD_KEYS) {
        if (
            !currentFirebaseUser ||
            currentFirebaseUser.uid !== targetUser.uid
        ) {
            return false;
        }

        const succeeded = await saveCloudData(
            key,
            getLocalDataForCloud(key),
            true
        );

        if (!succeeded) {
            allSucceeded = false;
        }
    }

    return allSucceeded;
}

// ------------------------------------------------------------
// 클라우드 동기화
// ------------------------------------------------------------
// 클라우드 데이터가 존재하면 클라우드를 무조건 우선한다.
// 이렇게 해야 PC와 모바일의 서로 다른 LocalStorage가
// 로그인 순간 서로를 덮어쓰는 문제가 사라진다.
async function loadCloudDataOrMigrate(user) {
    const targetUser = user || currentFirebaseUser;

    if (!targetUser) {
        return {
            status: "no-user",
            cloudExists: false,
            hadErrors: true
        };
    }

    const results = await Promise.all(
        CLOUD_KEYS.map(async function (key) {
            const result = await getCloudData(key, targetUser);

            return {
                key: key,
                result: result
            };
        })
    );

    if (
        !currentFirebaseUser ||
        currentFirebaseUser.uid !== targetUser.uid
    ) {
        return {
            status: "cancelled",
            cloudExists: false,
            hadErrors: false
        };
    }

    const successfulResults = results.filter(function (item) {
        return item.result && item.result.ok;
    });

    const failedResults = results.filter(function (item) {
        return !item.result || !item.result.ok;
    });

    const existingCloudResults = successfulResults.filter(function (item) {
        return item.result.exists;
    });

    const cloudExists = existingCloudResults.length > 0;

    // --------------------------------------------------------
    // 1) 이 계정에 이미 클라우드 데이터가 있다.
    //    => 클라우드를 단일 진실 공급원으로 사용한다.
    // --------------------------------------------------------
    if (cloudExists) {
        results.forEach(function (item) {
            const result = item.result;

            if (!result || !result.ok) {
                // 읽기 실패는 기존 로컬 데이터를 건드리지 않는다.
                return;
            }

            if (result.exists) {
                setLocalDataFromCloud(
                    item.key,
                    result.value
                );
            } else {
                // 일부 문서만 존재하는 오래된 계정은
                // 없는 항목을 빈 데이터로 맞춰 기기별 차이를 없앤다.
                setLocalDataEmpty(item.key);
            }
        });

        return {
            status: failedResults.length > 0
                ? "cloud-partial"
                : "cloud-loaded",
            cloudExists: true,
            hadErrors: failedResults.length > 0
        };
    }

    // --------------------------------------------------------
    // 2) 클라우드 데이터가 하나도 없고,
    //    모든 읽기가 성공했다.
    //    => 이 계정의 첫 로그인으로 간주하고 현재 로컬 데이터를
    //       클라우드에 1회 이관한다.
    // --------------------------------------------------------
    if (failedResults.length === 0) {
        const uploaded = await uploadAllLocalData(targetUser);

        return {
            status: uploaded
                ? "migrated-local-to-cloud"
                : "migration-failed",
            cloudExists: false,
            hadErrors: !uploaded
        };
    }

    // --------------------------------------------------------
    // 3) 클라우드가 없다고 확인된 것도 아니고 읽기 자체가 실패함.
    //    => 로컬 데이터는 살려두되 절대 클라우드에 덮어쓰지 않는다.
    // --------------------------------------------------------
    return {
        status: "read-failed",
        cloudExists: false,
        hadErrors: true
    };
}

function refreshDashboardAfterCloudLoad() {
    categories = loadFromStorage("categories", []);
    projects = loadFromStorage("projects", []);
    memos = loadFromStorage("memos", []);
    schedules = loadFromStorage("schedules", []);
    dDays = loadFromStorage("dDays", []);
    studyRecords = loadFromStorage("studyRecords", []);
    dailyStudyGoal =
        Number(localStorage.getItem("dailyStudyGoal")) || 3600;
    todoAlarmSettings = loadFromStorage("todoAlarmSettings", {
        enabled: false,
        times: []
    });
    normalizeTodoAlarmSettings();

    normalizeData();

    renderCalendar();
    showTodos();
    showMemos();
    showSchedules();
    showDDays();
    showProjects();

    loadStopwatchCategories();
    updateStopwatchDisplay();
    showStudyRecords();

    showStudyStats();
    showWeeklyStudyChart();
    showDailyStudyGoal();
}


// ============================================================
// Todo 알림 / Web Push
// ============================================================

function normalizeTodoAlarmSettings() {
    if (!todoAlarmSettings || typeof todoAlarmSettings !== "object") {
        todoAlarmSettings = {
            enabled: false,
            times: []
        };
    }

    todoAlarmSettings.enabled = todoAlarmSettings.enabled === true;

    if (!Array.isArray(todoAlarmSettings.times)) {
        todoAlarmSettings.times = [];
    }

    todoAlarmSettings.times = todoAlarmSettings.times
        .filter(function (time) {
            return /^\d{2}:\d{2}$/.test(time);
        })
        .filter(function (time, index, array) {
            return array.indexOf(time) === index;
        })
        .sort();

    return todoAlarmSettings;
}

function saveTodoAlarmSettings() {
    normalizeTodoAlarmSettings();
    saveData("todoAlarmSettings", todoAlarmSettings);
}

function setTodoAlarmStatus(message) {
    const status = document.getElementById("todoAlarmStatus");
    if (status) {
        status.textContent = message || "";
    }
}

function createTodoAlarmTimeRow(timeValue) {
    const row = createElement("div", "todo-alarm-time-row");

    const input = createElement("input");
    input.type = "time";
    input.value = timeValue || "";
    input.className = "todo-alarm-time-input";

    const removeButton = createElement(
        "button",
        "todo-alarm-remove-time",
        "삭제"
    );
    removeButton.type = "button";

    removeButton.addEventListener("click", function () {
        row.remove();
    });

    row.appendChild(input);
    row.appendChild(removeButton);

    return row;
}

function renderTodoAlarmPanel() {
    normalizeTodoAlarmSettings();

    const panel = document.getElementById("todoAlarmPanel");
    const enabled = document.getElementById("todoAlarmEnabled");
    const times = document.getElementById("todoAlarmTimes");

    if (!panel || !enabled || !times) {
        return;
    }

    enabled.checked = todoAlarmSettings.enabled;
    clearElement(times);

    todoAlarmSettings.times.forEach(function (time) {
        times.appendChild(createTodoAlarmTimeRow(time));
    });

    if (todoAlarmSettings.times.length === 0) {
        times.appendChild(createTodoAlarmTimeRow(""));
    }

    updateTodoAlarmPermissionUI();
}

function updateTodoAlarmPermissionUI() {
    const permissionButton = document.getElementById(
        "todoAlarmPermissionButton"
    );

    if (!permissionButton) {
        return;
    }

    if (!("Notification" in window)) {
        permissionButton.textContent = "이 브라우저는 알림을 지원하지 않음";
        permissionButton.disabled = true;
        return;
    }

    permissionButton.disabled = false;

    if (Notification.permission === "granted") {
        permissionButton.textContent = "알림 허용됨";
        return;
    }

    if (Notification.permission === "denied") {
        permissionButton.textContent = "브라우저 설정에서 알림 허용";
        return;
    }

    permissionButton.textContent = "알림 허용";
}

async function getTodoAlarmServiceWorker() {
    if (!("serviceWorker" in navigator)) {
        throw new Error("이 브라우저에서는 Service Worker를 사용할 수 없습니다.");
    }

    if (todoAlarmServiceWorkerRegistration) {
        return todoAlarmServiceWorkerRegistration;
    }

    todoAlarmServiceWorkerRegistration = await navigator.serviceWorker.register(
        "./firebase-messaging-sw.js"
    );

    return todoAlarmServiceWorkerRegistration;
}

async function registerTodoPushToken() {

    if (!currentFirebaseUser) {
        throw new Error("Google 로그인 후 알림을 설정해주세요.");
    }

    if (!("Notification" in window)) {
        throw new Error("이 브라우저는 알림 기능을 지원하지 않습니다.");
    }

    if (Notification.permission === "denied") {
        throw new Error(
            "알림 권한이 차단되어 있습니다. 브라우저 사이트 설정에서 알림을 허용해주세요."
        );
    }

    if (Notification.permission !== "granted") {
        const permission = await Notification.requestPermission();

        if (permission !== "granted") {
            throw new Error("알림 권한이 허용되지 않았습니다.");
        }
    }

    if (
        !TODO_ALARM_VAPID_KEY ||
        TODO_ALARM_VAPID_KEY === "YOUR_PUBLIC_VAPID_KEY_HERE"
    ) {
        throw new Error(
            "Firebase Web Push 공개 키(VAPID key)를 코드에 등록해야 합니다."
        );
    }

    const registration = await getTodoAlarmServiceWorker();

    if (!messaging) {
        messaging = getMessaging(firebaseApp);
    }

    const token = await getToken(messaging, {
        vapidKey: TODO_ALARM_VAPID_KEY,
        serviceWorkerRegistration: registration
    });

    if (!token) {
        throw new Error("푸시 토큰을 발급받지 못했습니다.");
    }

    const tokenIdBuffer = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(token)
    );

    const tokenId = Array.from(new Uint8Array(tokenIdBuffer))
        .map(function (byte) {
            return byte.toString(16).padStart(2, "0");
        })
        .join("");

    await setDoc(
        doc(
            db,
            "users",
            currentFirebaseUser.uid,
            "pushTokens",
            tokenId
        ),
        {
            token: token,
            platform: isMobileBrowser ? "mobile-web" : "web",
            userAgent: navigator.userAgent || "",
            updatedAt: serverTimestamp()
        },
        {
            merge: true
        }
    );

    return token;
}

async function enableTodoPushFromUserAction() {
    setTodoAlarmStatus("알림 권한을 확인하는 중...");

    try {
        await registerTodoPushToken();
        setTodoAlarmStatus("알림을 사용할 준비가 됐습니다.");
        updateTodoAlarmPermissionUI();
        return true;
    } catch (error) {
        console.error("Todo 푸시 등록 실패:", error);
        setTodoAlarmStatus(error.message || "알림 등록에 실패했습니다.");
        return false;
    }
}

async function syncTodoPushRegistrationAfterLogin() {
    normalizeTodoAlarmSettings();

    if (!todoAlarmSettings.enabled) {
        return;
    }

    if (
        !("Notification" in window) ||
        Notification.permission !== "granted"
    ) {
        return;
    }

    if (
        !TODO_ALARM_VAPID_KEY ||
        TODO_ALARM_VAPID_KEY === "YOUR_PUBLIC_VAPID_KEY_HERE"
    ) {
        return;
    }

    try {
        await registerTodoPushToken();
    } catch (error) {
        console.warn("기존 Todo 푸시 토큰 동기화 실패:", error);
    }
}

function collectTodoAlarmTimesFromUI() {
    const inputs = Array.from(
        document.querySelectorAll(".todo-alarm-time-input")
    );

    const values = inputs
        .map(function (input) {
            return input.value;
        })
        .filter(function (value) {
            return /^\d{2}:\d{2}$/.test(value);
        })
        .filter(function (value, index, array) {
            return array.indexOf(value) === index;
        })
        .sort();

    return values;
}

async function saveTodoAlarmSettingsFromUI() {
    const enabledInput = document.getElementById("todoAlarmEnabled");

    if (!enabledInput) {
        return;
    }

    const nextSettings = {
        enabled: enabledInput.checked,
        times: collectTodoAlarmTimesFromUI(),
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"
    };

    if (nextSettings.enabled && nextSettings.times.length === 0) {
        setTodoAlarmStatus("알림 시간을 하나 이상 정해주세요.");
        return;
    }

    todoAlarmSettings = nextSettings;
    saveTodoAlarmSettings();

    if (nextSettings.enabled) {
        const registered = await enableTodoPushFromUserAction();

        if (!registered) {
            todoAlarmSettings.enabled = false;
            saveTodoAlarmSettings();
            enabledInput.checked = false;
            return;
        }
    }

    setTodoAlarmStatus(
        nextSettings.enabled
            ? "저장됐습니다. 설정한 시간에 오늘 남은 Todo를 알려드립니다."
            : "Todo 알림을 껐습니다."
    );
}

function initTodoAlarmUI() {
    normalizeTodoAlarmSettings();

    const alarmButton = document.getElementById("todoAlarmButton");
    const closeButton = document.getElementById("todoAlarmCloseButton");
    const panel = document.getElementById("todoAlarmPanel");
    const addTimeButton = document.getElementById(
        "todoAlarmAddTimeButton"
    );
    const permissionButton = document.getElementById(
        "todoAlarmPermissionButton"
    );
    const saveButton = document.getElementById(
        "todoAlarmSaveButton"
    );

    if (!panel) {
        return;
    }

    renderTodoAlarmPanel();

    if (alarmButton) {
        alarmButton.addEventListener("click", function () {
            panel.style.display =
                panel.style.display === "none"
                    ? "block"
                    : "none";

            if (panel.style.display !== "none") {
                renderTodoAlarmPanel();
            }
        });
    }

    if (closeButton) {
        closeButton.addEventListener("click", function () {
            panel.style.display = "none";
        });
    }

    if (addTimeButton) {
        addTimeButton.addEventListener("click", function () {
            const times = document.getElementById("todoAlarmTimes");

            if (!times) return;

            times.appendChild(createTodoAlarmTimeRow(""));
        });
    }

    if (permissionButton) {
        permissionButton.addEventListener(
            "click",
            enableTodoPushFromUserAction
        );
    }

    if (saveButton) {
        saveButton.addEventListener(
            "click",
            saveTodoAlarmSettingsFromUI
        );
    }

    updateTodoAlarmPermissionUI();
}

async function initTodoForegroundMessaging() {
    try {
        if (!("serviceWorker" in navigator)) {
            return;
        }

        if (!("PushManager" in window)) {
            return;
        }

        if (!messaging) {
            messaging = getMessaging(firebaseApp);
        }

        onMessage(messaging, function (payload) {
            console.log("Todo 알림 수신:", payload);

            const notification = payload && payload.notification
                ? payload.notification
                : {};

            const data = payload && payload.data
                ? payload.data
                : {};

            const title =
                notification.title ||
                data.title ||
                "📋 My Dashboard";

            const body =
                notification.body ||
                data.body ||
                "오늘 할 일을 확인해주세요.";

            if (
                document.visibilityState === "visible" &&
                "serviceWorker" in navigator
            ) {
                navigator.serviceWorker.ready.then(function (registration) {
                    registration.showNotification(title, {
                        body: body,
                        icon: "/icon-192.png",
                        badge: "/icon-192.png",
                        tag: data.tag || "todo-alarm",
                        renotify: true,
                        data: {
                            url: "/"
                        }
                    });
                });
            }
        });
    } catch (error) {
        console.warn("Todo 포그라운드 푸시 초기화 실패:", error);
    }
}



function describeAuthError(error) {
    if (!error) {
        return "알 수 없는 로그인 오류가 발생했습니다.";
    }

    switch (error.code) {
        case "auth/popup-closed-by-user":
            return "Google 로그인 창이 닫혔습니다.";

        case "auth/popup-blocked":
            return "브라우저가 Google 로그인 창을 차단했습니다. 팝업 허용 후 다시 눌러주세요.";

        case "auth/popup-operation-not-supported":
            return "현재 브라우저에서는 Google 팝업 로그인을 사용할 수 없습니다.";

        case "auth/unauthorized-domain":
            return "현재 사이트 주소가 Firebase 승인된 도메인에 등록되어 있지 않습니다.";

        case "auth/operation-not-allowed":
            return "Firebase에서 Google 로그인이 활성화되어 있지 않습니다.";

        case "auth/network-request-failed":
            return "네트워크 연결을 확인해주세요.";

        case "auth/cancelled-popup-request":
            return "이미 진행 중인 Google 로그인 요청이 있습니다.";

        case "auth/web-storage-unsupported":
            return "브라우저 저장소를 사용할 수 없어 로그인할 수 없습니다.";

        case "auth/internal-error":
            return "Google 로그인 처리 중 브라우저 오류가 발생했습니다. 페이지를 새로고침한 뒤 다시 시도해주세요.";

        default:
            return error.message
                ? "Google 로그인 오류: " + error.message
                : "Google 로그인 중 오류가 발생했습니다.";
    }
}

async function handleGoogleLogin() {
    const button = document.getElementById("googleLoginButton");

    if (!button || authHandling) {
        return;
    }

    authHandling = true;
    button.disabled = true;
    setAuthMessage(
        isMobileBrowser
            ? "Google 로그인 창을 여는 중..."
            : "Google 로그인 중..."
    );

    try {
        const persistenceOk = await authPersistenceReady;

        if (!persistenceOk && isMobileBrowser) {
            console.warn(
                "모바일 인증 persistence 설정에 실패했지만 popup 로그인을 계속 시도합니다."
            );
        }

        googleProvider.setCustomParameters({
            prompt: "select_account"
        });

        // PC/모바일 모두 popup을 사용한다.
        // redirect 인증은 현재 구조에서 사용하지 않는다.
        console.log("Google 팝업 로그인 시작");

        const result = await signInWithPopup(
            auth,
            googleProvider
        );

        if (result && result.user) {
            console.log(
                isMobileBrowser
                    ? "[MOBILE] Google 계정 선택 완료"
                    : "[PC] Google 계정 선택 완료",
                result.user.email,
                result.user.uid
            );
            console.log(
                "Google 로그인 성공:",
                result.user.email,
                result.user.uid
            );

            // 모바일 브라우저에서 onAuthStateChanged 이벤트 전달이 늦더라도
            // popup 결과 자체로 즉시 로그인 절차를 이어간다.
            await activateSignedInUser(result.user);
        }
    } catch (error) {
        console.error("Google 로그인 오류:", error);
        setAuthMessage(describeAuthError(error));
    } finally {
        authHandling = false;

        if (button) {
            button.disabled = false;
        }
    }
}

async function handleLogout() {
    if (authHandling) {
        return;
    }

    authHandling = true;
    cloudSyncReady = false;
    cloudHydrating = false;
    authOperationId += 1;

    if (logoutButton) {
        logoutButton.disabled = true;
    }

    setAuthMessage("로그아웃 중...");
    lockDashboard();

    try {
        await signOut(auth);
        currentFirebaseUser = null;
        activeSyncPromise = null;
        activeSyncUid = null;
        setAuthMessage("");
    } catch (error) {
        console.error("로그아웃 오류:", error);

        if (currentFirebaseUser) {
            unlockDashboard();
        }

        setAuthMessage(
            "로그아웃에 실패했습니다. 다시 시도해주세요."
        );
    } finally {
        authHandling = false;

        if (logoutButton) {
            logoutButton.disabled = false;
        }
    }
}

async function runUserSyncWithTimeout(user, timeoutMs) {
    const syncPromise = loadCloudDataOrMigrate(user);

    if (!isMobileBrowser) {
        return await syncPromise;
    }

    return await withTimeout(
        syncPromise,
        timeoutMs,
        "모바일 클라우드 동기화"
    );
}

async function activateSignedInUser(user) {
    if (!user) return;

    // 이미 같은 계정이 활성화된 경우에는 화면만 보장한다.
    if (
        currentFirebaseUser &&
        currentFirebaseUser.uid === user.uid &&
        cloudSyncReady &&
        !cloudHydrating
    ) {
        unlockDashboard();
        return;
    }

    // 같은 인증 이벤트가 두 번 들어와도 동기화를 중복 실행하지 않는다.
    if (activeSyncPromise && activeSyncUid === user.uid) {
        // 모바일에서는 이미 화면을 열어 둔 뒤 백그라운드에서 동기화한다.
        unlockDashboard();
        return;
    }

    currentFirebaseUser = user;
    cloudSyncReady = false;
    cloudHydrating = true;

    const operationId = ++authOperationId;
    activeSyncUid = user.uid;

    if (accountUserName) {
        accountUserName.textContent =
            user.displayName ||
            user.email ||
            "Google 사용자";
    }

    // ========================================================
    // 중요: 로그인과 Firestore를 분리한다.
    // 인증이 성공하면 먼저 대시보드에 입장시킨다.
    // Firestore가 느리거나 막혀 있어도 무한로딩하지 않는다.
    // ========================================================
    unlockDashboard();
    setAuthMessage(
        isMobileBrowser
            ? "로그인 완료 · 클라우드 데이터를 확인하는 중..."
            : "로그인 완료 · 클라우드 데이터를 확인하는 중..."
    );

    const syncPromise = (async function () {
        try {
            const result = await runUserSyncWithTimeout(user, 8000);

            if (
                operationId !== authOperationId ||
                !currentFirebaseUser ||
                currentFirebaseUser.uid !== user.uid
            ) {
                return;
            }

            // 클라우드 데이터를 적용한 뒤 화면 갱신.
            // cloudHydrating=true 동안은 일반 저장이 Firestore로 가지 않는다.
            try {
                refreshDashboardAfterCloudLoad();
            } catch (renderError) {
                console.error("클라우드 데이터 화면 갱신 실패:", renderError);
            }

            cloudHydrating = false;
            cloudSyncReady = result.status !== "read-failed" || result.hasCloudData;

            syncTodoPushRegistrationAfterLogin();

            if (result.status === "read-failed") {
                setAuthMessage(
                    "로그인은 완료됐습니다. 클라우드 데이터를 불러오지 못해 현재 기기 데이터를 사용합니다."
                );
            } else if (result.status === "cloud-partial") {
                setAuthMessage(
                    "로그인은 완료됐습니다. 일부 클라우드 데이터만 불러왔습니다."
                );
            } else {
                setAuthMessage("");
            }
        } catch (error) {
            console.error("Firebase 백그라운드 동기화 실패:", error);

            if (
                operationId !== authOperationId ||
                !currentFirebaseUser ||
                currentFirebaseUser.uid !== user.uid
            ) {
                return;
            }

            cloudHydrating = false;
            cloudSyncReady = false;

            try {
                // 클라우드 실패 시에도 이미 열린 대시보드는 유지한다.
                refreshDashboardAfterCloudLoad();
            } catch (renderError) {
                console.error("로컬 데이터 화면 갱신 실패:", renderError);
            }

            unlockDashboard();
            setAuthMessage(
                "로그인은 완료됐습니다. 클라우드 연결에 실패해 현재 기기 데이터를 사용합니다."
            );
        }
    })();

    activeSyncPromise = syncPromise;

    // 절대 여기서 await하지 않는다.
    // 로그인 성공 후 모바일 화면이 Firestore 응답을 기다리며 멈추는 것을 방지한다.
    syncPromise.finally(function () {
        if (activeSyncUid === user.uid) {
            activeSyncPromise = null;
            activeSyncUid = null;
        }
    });
}

// 인증 상태 리스너는 페이지 시작 즉시 등록한다.
// redirect 결과를 따로 기다리지 않는다.
onAuthStateChanged(
    auth,
    async function (user) {
        if (!user) {
            authOperationId += 1;
            currentFirebaseUser = null;
            cloudSyncReady = false;
            cloudHydrating = false;
            activeSyncPromise = null;
            activeSyncUid = null;

            lockDashboard();

            if (accountUserName) {
                accountUserName.textContent = "";
            }

            if (googleLoginButton) {
                googleLoginButton.disabled = false;
            }

            setAuthMessage("");
            return;
        }

        await activateSignedInUser(user);
    },
    function (error) {
        console.error(
            "Firebase 인증 상태 감시 실패:",
            error
        );

        currentFirebaseUser = null;
        cloudSyncReady = false;
        cloudHydrating = false;
        lockDashboard();
        setAuthMessage(
            isMobileBrowser
                ? "모바일에서 로그인 상태를 확인하지 못했습니다. 페이지를 새로고침한 뒤 다시 시도해주세요."
                : "로그인 상태를 확인하지 못했습니다. 페이지를 새로고침해주세요."
        );
    }
);

if (googleLoginButton) {
    googleLoginButton.addEventListener(
        "click",
        function (event) {
            event.preventDefault();
            event.stopPropagation();
            handleGoogleLogin();
        }
    );
}

if (logoutButton) {
    logoutButton.addEventListener(
        "click",
        function (event) {
            event.preventDefault();
            event.stopPropagation();
            handleLogout();
        }
    );
}

// ============================================================
// ============================================================
// ============================================================
// 1. 공통 유틸리티
// ============================================================

function getElement(id) {
    return document.getElementById(id);
}


function pad(number) {
    return String(number).padStart(2, "0");
}


function getDateString(date) {
    return (
        `${date.getFullYear()}-` +
        `${pad(date.getMonth() + 1)}-` +
        `${pad(date.getDate())}`
    );
}


function getTodayString() {
    return getDateString(new Date());
}


function getTomorrowString() {
    const date = new Date();

    date.setDate(
        date.getDate() + 1
    );

    return getDateString(date);
}


function getMonday(date) {
    const result = new Date(date);

    const day = result.getDay();

    const difference =
        day === 0
            ? -6
            : 1 - day;

    result.setDate(
        result.getDate() + difference
    );

    result.setHours(
        0,
        0,
        0,
        0
    );

    return result;
}


function createId(prefix) {
    return (
        `${prefix}_` +
        Date.now() +
        "_" +
        Math.random()
            .toString(36)
            .slice(2)
    );
}


function createTodoId() {
    return createId("todo");
}


function createScheduleId() {
    return createId("schedule");
}


function saveToStorage(key, data) {
    localStorage.setItem(
        key,
        JSON.stringify(data)
    );

    // 기존 LocalStorage 저장은 그대로 유지하면서
    // 로그인 상태에서는 Firebase에도 같은 데이터를 저장한다.
    saveCloudData(key, data);
}


function loadFromStorage(
    key,
    defaultValue = []
) {
    const saved =
        localStorage.getItem(key);

    if (saved === null) {
        return defaultValue;
    }

    try {
        return JSON.parse(saved);
    }

    catch (error) {
        console.error(
            `${key} 데이터를 불러오는 중 오류가 발생했습니다.`,
            error
        );

        return defaultValue;
    }
}


function createElement(
    tag,
    className = "",
    text = ""
) {
    const element =
        document.createElement(tag);

    if (className) {
        element.className =
            className;
    }

    if (text !== "") {
        element.textContent =
            text;
    }

    return element;
}


function clearElement(element) {
    if (element) {
        element.innerHTML = "";
    }
}


// ============================================================
// 공통: ⋮ 액션 메뉴
// ============================================================

function closeActionMenus() {
    document.querySelectorAll(".action-menu.open").forEach(function (menu) {
        menu.classList.remove("open");
    });
}

function createActionMenu(onEdit, onDelete) {
    const wrapper = createElement("div", "action-menu");
    const trigger = createElement("button", "action-menu-trigger", "⋮");
    const menu = createElement("div", "action-menu-list");
    const editButton = createElement("button", "action-menu-item", "수정");
    const deleteButton = createElement("button", "action-menu-item", "삭제");

    trigger.type = "button";
    trigger.setAttribute("aria-label", "더보기");
    trigger.title = "더보기";
    editButton.type = "button";
    deleteButton.type = "button";

    trigger.addEventListener("click", function (event) {
        event.stopPropagation();
        const wasOpen = wrapper.classList.contains("open");
        closeActionMenus();
        if (!wasOpen) wrapper.classList.add("open");
    });

    editButton.addEventListener("click", function (event) {
        event.stopPropagation();
        closeActionMenus();
        onEdit();
    });

    deleteButton.addEventListener("click", function (event) {
        event.stopPropagation();
        closeActionMenus();
        onDelete();
    });

    menu.appendChild(editButton);
    menu.appendChild(deleteButton);
    wrapper.appendChild(trigger);
    wrapper.appendChild(menu);

    return wrapper;
}

document.addEventListener("click", function () {
    closeActionMenus();
});

// ============================================================
// 메모 전체 보기 팝업
// ============================================================

let memoViewer = null;

function createMemoViewer() {
    if (memoViewer) return memoViewer;

    const overlay = createElement("div", "memo-viewer-overlay");
    const modal = createElement("div", "memo-viewer-modal");
    const header = createElement("div", "memo-viewer-header");
    const title = createElement("h2", "memo-viewer-title");
    const closeButton = createElement("button", "memo-viewer-close", "×");
    const content = createElement("div", "memo-viewer-content");

    closeButton.type = "button";
    closeButton.setAttribute("aria-label", "닫기");

    closeButton.addEventListener("click", closeMemoViewer);
    overlay.addEventListener("click", function (event) {
        if (event.target === overlay) closeMemoViewer();
    });

    header.appendChild(title);
    header.appendChild(closeButton);
    modal.appendChild(header);
    modal.appendChild(content);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    memoViewer = { overlay, title, content };
    return memoViewer;
}

function openMemoViewer(memo) {
    const viewer = createMemoViewer();
    viewer.title.textContent = memo.title || "제목 없음";
    viewer.content.innerHTML = memo.content || "";
    viewer.overlay.classList.add("open");
}

function closeMemoViewer() {
    if (memoViewer) memoViewer.overlay.classList.remove("open");
}

// ============================================================
// 2. 날짜 상태
// ============================================================

const today =
    new Date();

const initialTodayString =
    getTodayString();

let selectedDate =
    initialTodayString;

let todoFilter =
    "today";

let currentYear =
    today.getFullYear();

let currentMonth =
    today.getMonth();


function getCurrentSelectedDate() {
    return selectedDate;
}


// ============================================================
// 3. DOM 요소
// ============================================================

// --------------------
// Todo
// --------------------

const categoryList =
    getElement("categoryList");

const addCategoryButton =
    getElement("addCategoryButton");

const calendarDays =
    getElement("calendarDays");

const monthTitle =
    getElement("monthTitle");

const selectedDateTitle =
    getElement("selectedDateTitle");

const todoCount =
    getElement("todoCount");

const prevMonthButton =
    getElement("prevMonth");

const nextMonthButton =
    getElement("nextMonth");

const todayFilter =
    getElement("todayFilter");

const tomorrowFilter =
    getElement("tomorrowFilter");

const weekFilter =
    getElement("weekFilter");


// --------------------
// 메모
// --------------------

const memoList =
    getElement("memoList");

const memoEditor =
    getElement("memoEditor");

const memoTitle =
    getElement("memoTitle");

const memoContent =
    getElement("memoContent");

const newMemoButton =
    getElement("newMemoButton");

const saveMemoButton =
    getElement("saveMemoButton");

const cancelMemoButton =
    getElement("cancelMemoButton");


// --------------------
// 일정
// --------------------

const scheduleList =
    getElement("scheduleList");

const scheduleEditor =
    getElement("scheduleEditor");

const scheduleTitle =
    getElement("scheduleTitle");

const scheduleStart =
    getElement("scheduleStart");

const scheduleEnd =
    getElement("scheduleEnd");

const scheduleColor =
    getElement("scheduleColor");

const scheduleDescription =
    getElement("scheduleDescription");

const scheduleRepeat =
    getElement("scheduleRepeat");

const newScheduleButton =
    getElement("newScheduleButton");

const saveScheduleButton =
    getElement("saveScheduleButton");

const cancelScheduleButton =
    getElement("cancelScheduleButton");

const scheduleArcs =
    getElement("scheduleArcs");

const hourHand =
    getElement("hourHand");

const clockNumbers =
    getElement("clockNumbers");

const clockTicks =
    getElement("clockTicks");


// --------------------
// D-Day
// --------------------

const ddayList =
    getElement("ddayList");

const ddayEditor =
    getElement("ddayEditor");

const ddayTitle =
    getElement("ddayTitle");

const ddayDate =
    getElement("ddayDate");

const newDdayButton =
    getElement("newDdayButton");

const saveDdayButton =
    getElement("saveDdayButton");

const cancelDdayButton =
    getElement("cancelDdayButton");


// --------------------
// 프로젝트
// --------------------

const newProjectButton =
    getElement("newProjectButton");

const projectEditor =
    getElement("projectEditor");

const projectList =
    getElement("projectList");

const projectTitle =
    getElement("projectTitle");

const projectStartDate =
    getElement("projectStartDate");

const projectEndDate =
    getElement("projectEndDate");

const projectItems =
    getElement("projectItems");

const saveProjectButton =
    getElement("saveProjectButton");

const cancelProjectButton =
    getElement("cancelProjectButton");


// --------------------
// 스톱워치
// --------------------

const stopwatchDisplay =
    getElement("stopwatchDisplay");

const stopwatchCategory =
    getElement("stopwatchCategory");

const stopwatchStartButton =
    getElement("stopwatchStartButton");

const stopwatchResetButton =
    getElement("stopwatchResetButton");

const studyRecordList =
    getElement("studyRecordList");


// --------------------
// 통계
// --------------------

const todayStudyTime =
    getElement("todayStudyTime");

const weekStudyTime =
    getElement("weekStudyTime");

const dailyStudyGoalElement =
    getElement("dailyStudyGoal");

const categoryStudyStats =
    getElement("categoryStudyStats");

const categoryStudyRatio =
    getElement("categoryStudyRatio");

const weeklyStudyChart =
    getElement("weeklyStudyChart");

const setStudyGoalButton =
    getElement("setStudyGoalButton");


// 카테고리별 공부시간 기간
let categoryStudyPeriod = "week";

const statsPeriodButtons =
    document.querySelectorAll(".stats-period-button");


// ============================================================
// 4. 데이터
// ============================================================

let categories =
    loadFromStorage(
        "categories",
        []
    );


let projects =
    loadFromStorage(
        "projects",
        []
    );


let memos =
    loadFromStorage(
        "memos",
        []
    );


let schedules =
    loadFromStorage(
        "schedules",
        []
    );


let dDays =
    loadFromStorage(
        "dDays",
        []
    );


let studyRecords =
    loadFromStorage(
        "studyRecords",
        []
    );


let dailyStudyGoal =
    Number(
        localStorage.getItem(
            "dailyStudyGoal"
        )
    ) || 3600;


// --------------------
// 편집 상태
// --------------------

let editingMemo =
    null;

let editingSchedule =
    null;

let editingScheduleId =
    null;

let editingDday =
    null;

let editingProjectIndex =
    null;


// --------------------
// 일정 ↔ Todo
// --------------------

let selectedScheduleTodoIds =
    [];


// ============================================================
// 카테고리 색상
// ============================================================

const CATEGORY_COLORS = [
    "#4a90e2",
    "#e74c3c",
    "#f39c12",
    "#27ae60",
    "#8e44ad",
    "#16a085",
    "#e67e22",
    "#2c3e50",
    "#d81b60",
    "#00acc1"
];

function getDefaultCategoryColor(index = 0) {
    return CATEGORY_COLORS[
        Math.abs(index) % CATEGORY_COLORS.length
    ];
}

function getCategoryByName(name) {
    return categories.find(function (category) {
        return category.name === name;
    }) || null;
}


// ============================================================
// 5. 데이터 정규화
// ============================================================
//
// 예전에 만든 LocalStorage 데이터와
// 현재 버전 데이터의 차이를 자동으로 보정한다.
// ============================================================

function normalizeData() {

    normalizeTodoAlarmSettings();

    // --------------------
    // Categories
    // --------------------

    if (!Array.isArray(categories)) {
        categories = [];
    }


    categories.forEach(
        function (category) {

            if (
                typeof category.name !==
                "string"
            ) {
                category.name = "새 카테고리";
            }


            if (!category.color) {
                category.color = getDefaultCategoryColor(categories.indexOf(category));
            }


            if (
                !Array.isArray(category.todos)
            ) {
                category.todos = [];
            }


            category.todos.forEach(
                function (todo) {

                    if (!todo.id) {
                        todo.id =
                            createTodoId();
                    }


                    if (
                        typeof todo.text !==
                        "string"
                    ) {
                        todo.text = "";
                    }


                    if (
                        typeof todo.completed !==
                        "boolean"
                    ) {
                        todo.completed = false;
                    }


                    if (!todo.date) {
                        todo.date =
                            getTodayString();
                    }


                    if (
                        ![
                            "high",
                            "normal",
                            "low"
                        ].includes(
                            todo.priority
                        )
                    ) {
                        todo.priority =
                            "normal";
                    }


                    if (
                        ![
                            "none",
                            "daily",
                            "weekly"
                        ].includes(
                            todo.repeat
                        )
                    ) {
                        todo.repeat =
                            "none";
                    }


                    if (
                        typeof todo.deadline !==
                        "string"
                    ) {
                        todo.deadline = "";
                    }


                    if (
                        !Array.isArray(
                            todo.completedDates
                        )
                    ) {
                        todo.completedDates =
                            [];
                    }


                    if (
                        todo.scheduleId ===
                        undefined
                    ) {
                        todo.scheduleId =
                            null;
                    }

                }
            );

        }
    );


    // --------------------
    // Projects
    // --------------------

    if (!Array.isArray(projects)) {
        projects = [];
    }


    projects.forEach(
        function (project) {

            if (
                !Array.isArray(
                    project.tasks
                )
            ) {
                project.tasks = [];
            }


            project.tasks.forEach(
                function (task) {

                    if (
                        typeof task.text !==
                        "string"
                    ) {
                        task.text = "";
                    }


                    task.completed =
                        task.completed === true;

                }
            );

        }
    );


    // --------------------
    // Memos
    // --------------------

    if (!Array.isArray(memos)) {
        memos = [];
    }


    // --------------------
    // Schedules
    // --------------------

    if (!Array.isArray(schedules)) {
        schedules = [];
    }


    schedules.forEach(
        function (schedule) {

            if (!schedule.id) {
                schedule.id =
                    createScheduleId();
            }


            if (!schedule.repeat) {
                schedule.repeat =
                    "none";
            }


            if (!Array.isArray(
                schedule.todoIds
            )) {
                schedule.todoIds = [];
            }


            if (!schedule.color) {
                schedule.color =
                    "#4a90e2";
            }


            if (!schedule.description) {
                schedule.description =
                    "";
            }

        }
    );


    // --------------------
    // D-Day
    // --------------------

    if (!Array.isArray(dDays)) {
        dDays = [];
    }


    // --------------------
    // Study records
    // --------------------

    if (!Array.isArray(studyRecords)) {
        studyRecords = [];
    }


    // --------------------
    // ID가 없는 Todo 보정
    // --------------------

    saveCategories();
    saveSchedules();
    saveProjects();
    saveMemos();
    saveDDays();
    saveStudyRecords();

}


// ============================================================
// 6. 저장 함수
// ============================================================

const STORAGE_KEYS = {
    categories: "categories",
    projects: "projects",
    memos: "memos",
    schedules: "schedules",
    dDays: "dDays",
    studyRecords: "studyRecords"
};

function saveData(key, data) {
    saveToStorage(key, data);
}

function saveCategories() { saveData(STORAGE_KEYS.categories, categories); }
function saveProjects() { saveData(STORAGE_KEYS.projects, projects); }
function saveMemos() { saveData(STORAGE_KEYS.memos, memos); }
function saveSchedules() { saveData(STORAGE_KEYS.schedules, schedules); }
function saveDDays() { saveData(STORAGE_KEYS.dDays, dDays); }
function saveStudyRecords() { saveData(STORAGE_KEYS.studyRecords, studyRecords); }

function refreshTodoViews(includeSchedules = false) {
    showTodos();
    renderCalendar();
    if (includeSchedules) showSchedules();
}


// ============================================================
// 7. Todo - 반복 / 완료
// ============================================================

function todoAppearsOnDate(
    todo,
    targetDate
) {

    const repeat =
        todo.repeat || "none";


    // --------------------
    // 반복 없음
    // --------------------

    if (repeat === "none") {

        return (
            todo.date ===
            targetDate
        );

    }


    // 시작일 이전
    if (
        targetDate <
        todo.date
    ) {
        return false;
    }


    // --------------------
    // 매일
    // --------------------

    if (
        repeat === "daily"
    ) {
        return true;
    }


    // --------------------
    // 매주
    // --------------------

    if (
        repeat === "weekly"
    ) {

        const startDate =
            new Date(
                todo.date +
                "T00:00:00"
            );

        const targetDateObject =
            new Date(
                targetDate +
                "T00:00:00"
            );


        return (
            startDate.getDay() ===
            targetDateObject.getDay()
        );

    }


    return false;
}


function isTodoCompletedOnDate(
    todo,
    dateString
) {

    const repeat =
        todo.repeat || "none";


    if (
        repeat !== "none"
    ) {

        return (
            Array.isArray(
                todo.completedDates
            ) &&
            todo.completedDates.includes(
                dateString
            )
        );

    }


    return (
        todo.completed === true
    );
}


function getTodoCountForDate(
    dateString
) {

    let count = 0;


    categories.forEach(
        function (category) {

            category.todos.forEach(
                function (todo) {

                    if (
                        todoAppearsOnDate(
                            todo,
                            dateString
                        ) &&
                        !isTodoCompletedOnDate(
                            todo,
                            dateString
                        )
                    ) {
                        count++;
                    }

                }
            );

        }
    );


    return count;
}


// ============================================================
// 8. Todo - 우선순위 / 정렬
// ============================================================

const priorityOrder = {
    high: 0,
    normal: 1,
    low: 2
};


function getPriorityEmoji(
    priority
) {

    switch (priority) {

        case "high":
            return "🔴";

        case "low":
            return "🟢";

        default:
            return "🟡";

    }
}


function sortTodos(todos) {

    return todos.sort(
        function (a, b) {

            const priorityA =
                priorityOrder[
                a.priority ||
                "normal"
                ];

            const priorityB =
                priorityOrder[
                b.priority ||
                "normal"
                ];


            if (
                priorityA !==
                priorityB
            ) {
                return (
                    priorityA -
                    priorityB
                );
            }


            const deadlineA =
                a.deadline ||
                "99:99";

            const deadlineB =
                b.deadline ||
                "99:99";


            return deadlineA.localeCompare(
                deadlineB
            );

        }
    );

}


// ============================================================
// 9. Todo - Select 생성
// ============================================================

function createRepeatSelect(
    currentValue = "none"
) {

    const select =
        createElement(
            "select",
            "todo-repeat-select"
        );


    const options = [
        ["none", "오늘만"],
        ["daily", "매일"],
        ["weekly", "매주"]
    ];


    options.forEach(
        function (data) {

            const option =
                createElement(
                    "option"
                );

            option.value =
                data[0];

            option.textContent =
                data[1];

            select.appendChild(
                option
            );

        }
    );


    select.value =
        currentValue;


    return select;
}


function createPrioritySelect(
    currentValue = "normal"
) {

    const select =
        createElement(
            "select",
            "todo-priority-select"
        );


    const options = [
        ["high", "높음"],
        ["normal", "보통"],
        ["low", "낮음"]
    ];


    options.forEach(
        function (data) {

            const option =
                createElement(
                    "option"
                );

            option.value =
                data[0];

            option.textContent =
                data[1];

            select.appendChild(
                option
            );

        }
    );


    select.value =
        currentValue;


    return select;
}


// ============================================================
// 10. Todo - 카테고리
// ============================================================

function createCategoryBox(
    category
) {

    const categoryBox =
        createElement(
            "div",
            "category"
        );


    const header =
        createElement(
            "div",
            "category-header"
        );


    const title =
        createElement(
            "h3",
            "",
            category.name
        );

    const colorInput =
        createElement(
            "input",
            "category-color-input"
        );

    colorInput.type = "color";
    colorInput.value =
        category.color || getDefaultCategoryColor(categories.indexOf(category));
    colorInput.title = "카테고리 색상";

    colorInput.addEventListener(
        "click",
        function (event) {
            event.stopPropagation();
        }
    );

    colorInput.addEventListener(
        "change",
        function () {
            category.color = colorInput.value;
            saveCategories();
            refreshTodoViews(true);
            loadStopwatchCategories();
            showStudyRecords();
            showStudyStats();
        }
    );


    // --------------------
    // Todo 추가
    // --------------------

    const addButton =
        createElement(
            "button",
            "category-add-button",
            "+"
        );


    addButton.addEventListener(
        "click",
        function (event) {

            event.stopPropagation();

            createTodoInputArea(
                category,
                categoryBox
            );

        }
    );


    // --------------------
    // 카테고리 삭제
    // --------------------

    const deleteButton =
        createElement(
            "button",
            "category-delete-button",
            "삭제"
        );


    deleteButton.addEventListener(
        "click",
        function (event) {

            event.stopPropagation();


            const confirmed =
                confirm(
                    `'${category.name}' 카테고리를 삭제할까요?`
                );


            if (!confirmed) {
                return;
            }


            categories =
                categories.filter(
                    function (currentCategory) {
                        return (
                            currentCategory !==
                            category
                        );
                    }
                );


            saveCategories();
            refreshTodoViews();

        }
    );


    header.appendChild(title);
    header.appendChild(colorInput);
    header.appendChild(addButton);
    header.appendChild(deleteButton);

    categoryBox.appendChild(header);


    return categoryBox;
}


// ============================================================
// 11. Todo - 입력 영역
// ============================================================

function createTodoInputArea(
    category,
    categoryBox
) {

    const existing = categoryBox.querySelector(".todo-input-area");

    if (existing) {
        existing.remove();
    }

    const inputArea = createElement("div", "todo-input-area");

    const firstRow = createElement("div", "todo-input-first-row");
    const secondRow = createElement("div", "todo-input-second-row");

    const checkBox = createElement("input", "todo-new-checkbox");
    checkBox.type = "checkbox";
    checkBox.title = "완료 상태";

    const input = createElement("input", "todo-input");
    input.type = "text";
    input.placeholder = "할 일을 입력하세요";

    const saveButton = createElement("button", "todo-button", "저장");
    saveButton.type = "button";

    const cancelButton = createElement("button", "todo-button", "취소");
    cancelButton.type = "button";

    const prioritySelect = createPrioritySelect("normal");
    const repeatSelect = createRepeatSelect("none");

    const deadlineWrap = createElement("div", "todo-deadline-wrap");
    const deadlineInput = createElement("input", "todo-deadline-input");
    deadlineInput.type = "time";
    deadlineInput.title = "시간";



    deadlineWrap.appendChild(deadlineInput);

    firstRow.appendChild(checkBox);
    firstRow.appendChild(input);
    firstRow.appendChild(saveButton);
    firstRow.appendChild(cancelButton);

    secondRow.appendChild(prioritySelect);
    secondRow.appendChild(repeatSelect);
    secondRow.appendChild(deadlineWrap);

    inputArea.appendChild(firstRow);
    inputArea.appendChild(secondRow);

    function saveTodo() {
        const text = input.value.trim();

        if (text === "") {
            input.focus();
            return;
        }

        category.todos.push({
            id: createTodoId(),
            text: text,
            completed: checkBox.checked,
            date: selectedDate,
            priority: prioritySelect.value,
            repeat: repeatSelect.value,
            deadline: deadlineInput.value,
            completedDates: checkBox.checked ? [selectedDate] : [],
            scheduleId: null
        });

        saveCategories();
        refreshTodoViews(true);
    }

    saveButton.addEventListener("click", saveTodo);

    cancelButton.addEventListener("click", function () {
        inputArea.remove();
    });

    input.addEventListener("keydown", function (event) {
        if (event.key === "Enter") {
            event.preventDefault();
            saveTodo();
        } else if (event.key === "Escape") {
            event.preventDefault();
            inputArea.remove();
        }
    });

    categoryBox.appendChild(inputArea);
    input.focus();
}


// ============================================================
// 12. Todo - 개별 Todo
// ============================================================

function createTodoItem(
    category,
    todo,
    dateString
) {

    const item =
        createElement(
            "li"
        );


    const repeat =
        todo.repeat || "none";


    // --------------------
    // 체크박스
    // --------------------

    const checkBox =
        createElement(
            "input"
        );

    checkBox.type =
        "checkbox";

    checkBox.checked =
        isTodoCompletedOnDate(
            todo,
            dateString
        );


    // --------------------
    // 우선순위
    // --------------------

    const priority =
        createElement(
            "span",
            "todo-priority"
        );


    // --------------------
    // 텍스트
    // --------------------

    const text =
        createElement(
            "span",
            "todo-text",
            todo.text
        );


    // --------------------
    // 마감시간
    // --------------------

    const deadline =
        createElement(
            "span",
            "todo-deadline",
            todo.deadline || ""
        );


    function updateTextDecoration() {

        text.style.textDecoration =
            checkBox.checked
                ? "line-through"
                : "none";

    }


    updateTextDecoration();


    // --------------------
    // 완료 처리
    // --------------------

    checkBox.addEventListener(
        "change",
        function () {

            const checked =
                checkBox.checked;


            if (
                repeat === "none"
            ) {

                todo.completed =
                    checked;

            }

            else {

                if (
                    !Array.isArray(
                        todo.completedDates
                    )
                ) {
                    todo.completedDates = [];
                }


                if (checked) {

                    if (
                        !todo.completedDates.includes(
                            dateString
                        )
                    ) {

                        todo.completedDates.push(
                            dateString
                        );

                    }

                }

                else {

                    todo.completedDates =
                        todo.completedDates.filter(
                            function (date) {

                                return (
                                    date !==
                                    dateString
                                );

                            }
                        );

                }

            }


            saveCategories();
            refreshTodoViews(true);

        }
    );


    // ========================================================
    // 수정 / 삭제
    // ========================================================

    const editButton =
        createElement(
            "button",
            "todo-button",
            "수정"
        );

    const deleteButton =
        createElement(
            "button",
            "todo-button",
            "삭제"
        );

    editButton.addEventListener(
        "click",
        function (event) {
            event.stopPropagation();

            // 수정 UI도 Todo 추가 UI와 완전히 같은 구조를 사용한다.
            // 기존 항목의 내용만 편집 영역으로 교체하고,
            // 저장/취소 후 다시 일반 Todo UI를 렌더링한다.
            const editArea = createElement("div", "todo-input-area todo-edit-area");

            const firstRow = createElement("div", "todo-input-first-row");
            const secondRow = createElement("div", "todo-input-second-row");

            const editCheckBox = createElement("input", "todo-new-checkbox");
            editCheckBox.type = "checkbox";
            editCheckBox.checked = isTodoCompletedOnDate(todo, dateString);
            editCheckBox.title = "완료 상태";

            const editInput = createElement("input", "todo-input");
            editInput.type = "text";
            editInput.value = todo.text || "";

            const saveButton = createElement("button", "todo-button", "저장");
            saveButton.type = "button";

            const cancelButton = createElement("button", "todo-button", "취소");
            cancelButton.type = "button";

            const editPriority = createPrioritySelect(todo.priority || "normal");
            const editRepeat = createRepeatSelect(todo.repeat || "none");

            const deadlineWrap = createElement("div", "todo-deadline-wrap");
            const editDeadline = createElement("input", "todo-deadline-input");
            editDeadline.type = "time";
            editDeadline.title = "시간";
            editDeadline.value = todo.deadline || "";

            deadlineWrap.appendChild(editDeadline);

            firstRow.appendChild(editCheckBox);
            firstRow.appendChild(editInput);
            firstRow.appendChild(saveButton);
            firstRow.appendChild(cancelButton);

            secondRow.appendChild(editPriority);
            secondRow.appendChild(editRepeat);
            secondRow.appendChild(deadlineWrap);

            editArea.appendChild(firstRow);
            editArea.appendChild(secondRow);

            // 기존 li 내부를 편집 UI 하나로 교체
            clearElement(item);
            item.appendChild(editArea);

            function saveEdit() {
                const newText = editInput.value.trim();
                if (newText === "") {
                    editInput.focus();
                    return;
                }

                const oldRepeat = todo.repeat || "none";
                const newRepeat = editRepeat.value;
                const currentCompletion = editCheckBox.checked;

                todo.text = newText;
                todo.priority = editPriority.value;
                todo.repeat = newRepeat;
                todo.deadline = editDeadline.value;

                if (newRepeat === "none") {
                    todo.completed = currentCompletion;
                    todo.completedDates = [];
                } else {
                    if (!Array.isArray(todo.completedDates)) {
                        todo.completedDates = [];
                    }

                    // 반복 Todo는 현재 날짜의 완료 상태만 기록한다.
                    const completionIndex = todo.completedDates.indexOf(dateString);
                    if (currentCompletion && completionIndex === -1) {
                        todo.completedDates.push(dateString);
                    } else if (!currentCompletion && completionIndex !== -1) {
                        todo.completedDates.splice(completionIndex, 1);
                    }

                    todo.completed = false;
                }

                saveCategories();
                refreshTodoViews(true);
            }

            saveButton.addEventListener("click", saveEdit);
            cancelButton.addEventListener("click", function () {
                showTodos();
            });

            editInput.addEventListener("keydown", function (event) {
                if (event.key === "Enter") {
                    event.preventDefault();
                    saveEdit();
                } else if (event.key === "Escape") {
                    event.preventDefault();
                    showTodos();
                }
            });

            editInput.focus();
            editInput.select();
        }
    );
    deleteButton.addEventListener(
        "click",
        function (event) {
            event.stopPropagation();

            const confirmed = confirm(`"${todo.text}" 할 일을 삭제할까요?`);
            if (!confirmed) return;

            schedules.forEach(function (schedule) {
                if (Array.isArray(schedule.todoIds)) {
                    schedule.todoIds = schedule.todoIds.filter(function (id) {
                        return id !== todo.id;
                    });
                }
            });

            category.todos = category.todos.filter(function (currentTodo) {
                return currentTodo !== todo;
            });

            saveCategories();
            saveSchedules();
            showTodos();
            showSchedules();
            renderCalendar();
        }
    );

    const actionMenu = createActionMenu(
        function () { editButton.click(); },
        function () { deleteButton.click(); }
    );

    item.classList.add(
        `todo-priority-${todo.priority || "normal"}`
    );

    // --------------------
    // 배치
    // --------------------

    item.appendChild(
        checkBox
    );

    item.appendChild(
        priority
    );

    item.appendChild(
        text
    );

    item.appendChild(
        deadline
    );

    item.appendChild(
        actionMenu
    );


    return item;
}


// ============================================================
// 13. Todo - 날짜 표시
// ============================================================

function showCategoryForDate(
    category,
    dateString
) {

    const categoryBox =
        createCategoryBox(
            category
        );


    const todoList =
        createElement(
            "ul",
            "category-todo-list"
        );


    const visibleTodos =
        sortTodos(
            category.todos.filter(
                function (todo) {

                    return todoAppearsOnDate(
                        todo,
                        dateString
                    );

                }
            )
        );


    const incompleteTodos =
        visibleTodos.filter(
            function (todo) {

                return !isTodoCompletedOnDate(
                    todo,
                    dateString
                );

            }
        );


    const completedTodos =
        visibleTodos.filter(
            function (todo) {

                return isTodoCompletedOnDate(
                    todo,
                    dateString
                );

            }
        );


    // --------------------
    // 미완료
    // --------------------

    incompleteTodos.forEach(
        function (todo) {

            todoList.appendChild(
                createTodoItem(
                    category,
                    todo,
                    dateString
                )
            );

        }
    );


    categoryBox.appendChild(
        todoList
    );


    // --------------------
    // 완료 목록
    // --------------------

    if (
        completedTodos.length > 0
    ) {

        const toggle =
            createElement(
                "button",
                "completed-todo-toggle",
                `▼ 완료한 할 일 (${completedTodos.length})`
            );


        const completedList =
            createElement(
                "ul",
                "category-todo-list completed-todo-list"
            );


        completedList.style.display =
            "none";


        completedTodos.forEach(
            function (todo) {

                completedList.appendChild(
                    createTodoItem(
                        category,
                        todo,
                        dateString
                    )
                );

            }
        );


        toggle.addEventListener(
            "click",
            function () {

                const hidden =
                    completedList.style.display ===
                    "none";


                if (hidden) {

                    completedList.style.display =
                        "block";

                    toggle.textContent =
                        `▲ 완료한 할 일 (${completedTodos.length})`;

                }

                else {

                    completedList.style.display =
                        "none";

                    toggle.textContent =
                        `▼ 완료한 할 일 (${completedTodos.length})`;

                }

            }
        );


        categoryBox.appendChild(
            toggle
        );

        categoryBox.appendChild(
            completedList
        );

    }


    categoryList.appendChild(
        categoryBox
    );
}


// ============================================================
// 14. Todo - 날짜 / 주간
// ============================================================

function showDateTodos(
    dateString
) {

    addCategoryButton.style.display =
        "block";


    clearElement(
        categoryList
    );


    selectedDateTitle.textContent =
        `${dateString} 할 일`;


    categories.forEach(
        function (category) {

            showCategoryForDate(
                category,
                dateString
            );

        }
    );


    updateTodoCount();
}


function showWeekTodos() {

    clearElement(
        categoryList
    );


    addCategoryButton.style.display =
        "none";


    selectedDateTitle.textContent =
        "이번 주 할 일";


    const monday =
        getMonday(
            new Date()
        );


    for (
        let i = 0;
        i < 7;
        i++
    ) {

        const date =
            new Date(monday);

        date.setDate(
            monday.getDate() + i
        );


        const dateString =
            getDateString(date);


        const dayBox =
            createElement(
                "div",
                "week-todo-day"
            );


        const dayTitle =
            createElement(
                "h3",
                "",
                dateString
            );


        dayBox.appendChild(
            dayTitle
        );


        categories.forEach(
            function (category) {

                const todos =
                    sortTodos(
                        category.todos.filter(
                            function (todo) {

                                return (
                                    todoAppearsOnDate(
                                        todo,
                                        dateString
                                    )
                                );

                            }
                        )
                    );


                if (
                    todos.length === 0
                ) {
                    return;
                }


                const categoryBox =
                    createElement(
                        "div",
                        "category"
                    );


                const header =
                    createElement(
                        "div",
                        "category-header"
                    );


                header.appendChild(
                    createElement(
                        "h3",
                        "",
                        category.name
                    )
                );


                categoryBox.appendChild(
                    header
                );


                const list =
                    createElement(
                        "ul",
                        "category-todo-list"
                    );


                todos.forEach(
                    function (todo) {

                        list.appendChild(
                            createTodoItem(
                                category,
                                todo,
                                dateString
                            )
                        );

                    }
                );


                categoryBox.appendChild(
                    list
                );

                dayBox.appendChild(
                    categoryBox
                );

            }
        );


        categoryList.appendChild(
            dayBox
        );

    }


    updateTodoCount();
}


function showTodos() {

    if (
        todoFilter === "week"
    ) {

        showWeekTodos();

        return;
    }


    showDateTodos(
        selectedDate
    );
}


// ============================================================
// 15. Todo - 개수
// ============================================================

function updateTodoCount() {

    if (
        todoFilter === "week"
    ) {

        const monday =
            getMonday(
                new Date()
            );


        let count = 0;


        for (
            let i = 0;
            i < 7;
            i++
        ) {

            const date =
                new Date(monday);

            date.setDate(
                monday.getDate() + i
            );


            count +=
                getTodoCountForDate(
                    getDateString(date)
                );

        }


        todoCount.textContent =
            `이번 주 남은 할 일: ${count}개`;

        return;
    }


    todoCount.textContent =
        `남은 할 일: ` +
        `${getTodoCountForDate(selectedDate)}개`;
}


// ============================================================
// 16. Todo - 카테고리 추가
// ============================================================

function addCategory() {

    const name =
        prompt(
            "새 카테고리 이름을 입력하세요"
        );


    if (
        name === null
    ) {
        return;
    }


    const trimmed =
        name.trim();


    if (
        trimmed === ""
    ) {
        return;
    }


    const duplicate =
        categories.some(
            function (category) {

                return (
                    category.name ===
                    trimmed
                );

            }
        );


    if (duplicate) {

        alert(
            "이미 존재하는 카테고리입니다."
        );

        return;
    }


    categories.push({

        name:
            trimmed,

        color:
            getDefaultCategoryColor(categories.length),

        todos:
            []

    });


    saveCategories();
    refreshTodoViews();

    loadStopwatchCategories();
}


if (addCategoryButton) {

    addCategoryButton.addEventListener(
        "click",
        addCategory
    );

}


// ============================================================
// 17. Todo - 필터
// ============================================================

function updateTodoFilterButtons() {

    document
        .querySelectorAll(
            ".todo-filter-button"
        )
        .forEach(
            function (button) {

                button.classList.remove(
                    "active"
                );

            }
        );


    if (
        todoFilter === "today" &&
        todayFilter
    ) {

        todayFilter.classList.add(
            "active"
        );

    }


    if (
        todoFilter === "tomorrow" &&
        tomorrowFilter
    ) {

        tomorrowFilter.classList.add(
            "active"
        );

    }


    if (
        todoFilter === "week" &&
        weekFilter
    ) {

        weekFilter.classList.add(
            "active"
        );

    }
}


function setTodoFilter(
    filter
) {

    todoFilter =
        filter;


    if (
        filter === "today"
    ) {

        selectedDate =
            getTodayString();


        const date =
            new Date();

        currentYear =
            date.getFullYear();

        currentMonth =
            date.getMonth();

    }


    else if (
        filter === "tomorrow"
    ) {

        const date =
            new Date();

        date.setDate(
            date.getDate() + 1
        );


        selectedDate =
            getDateString(date);

        currentYear =
            date.getFullYear();

        currentMonth =
            date.getMonth();

    }


    updateTodoFilterButtons();

    showTodos();

    renderCalendar();

    showSchedules();
}


if (todayFilter) {

    todayFilter.addEventListener(
        "click",
        function () {
            setTodoFilter("today");
        }
    );

}


if (tomorrowFilter) {

    tomorrowFilter.addEventListener(
        "click",
        function () {
            setTodoFilter("tomorrow");
        }
    );

}


if (weekFilter) {

    weekFilter.addEventListener(
        "click",
        function () {
            setTodoFilter("week");
        }
    );

}


// ============================================================
// 18. 달력
// ============================================================

function renderCalendar() {

    if (!calendarDays) {
        return;
    }


    clearElement(
        calendarDays
    );


    monthTitle.textContent =
        `${currentYear}년 ${currentMonth + 1}월`;


    const firstDay =
        new Date(
            currentYear,
            currentMonth,
            1
        );


    const lastDate =
        new Date(
            currentYear,
            currentMonth + 1,
            0
        ).getDate();


    // 월요일 시작
    const mondayStart =
        firstDay.getDay() === 0
            ? 6
            : firstDay.getDay() - 1;


    // --------------------
    // 빈칸
    // --------------------

    for (
        let i = 0;
        i < mondayStart;
        i++
    ) {

        const empty =
            createElement(
                "div",
                "calendar-day empty"
            );

        calendarDays.appendChild(
            empty
        );

    }


    // --------------------
    // 날짜
    // --------------------

    for (
        let day = 1;
        day <= lastDate;
        day++
    ) {

        const date =
            new Date(
                currentYear,
                currentMonth,
                day
            );


        const dateString =
            getDateString(date);


        const dayBox =
            createElement(
                "div",
                "calendar-day"
            );


        const number =
            createElement(
                "div",
                "day-number",
                String(day)
            );


        const countBox =
            createElement(
                "div",
                "day-todo-count"
            );


        const totalTodo =
            getTodoCountForDate(
                dateString
            );


        if (
            totalTodo > 0
        ) {

            countBox.textContent =
                `${totalTodo}개`;

        }


        // 선택
        if (
            dateString ===
            selectedDate
        ) {

            dayBox.classList.add(
                "selected"
            );

        }


        // 오늘
        if (
            dateString ===
            getTodayString()
        ) {

            dayBox.classList.add(
                "today"
            );

        }


        dayBox.appendChild(
            number
        );

        dayBox.appendChild(
            countBox
        );


        dayBox.addEventListener(
            "click",
            function () {

                selectedDate =
                    dateString;

                todoFilter =
                    "date";


                document
                    .querySelectorAll(
                        ".todo-filter-button"
                    )
                    .forEach(
                        function (button) {

                            button.classList.remove(
                                "active"
                            );

                        }
                    );


                showTodos();

                showSchedules();

                renderCalendar();

            }
        );


        calendarDays.appendChild(
            dayBox
        );

    }
}


if (prevMonthButton) {

    prevMonthButton.addEventListener(
        "click",
        function () {

            currentMonth--;


            if (
                currentMonth < 0
            ) {

                currentMonth =
                    11;

                currentYear--;

            }


            renderCalendar();

        }
    );

}


if (nextMonthButton) {

    nextMonthButton.addEventListener(
        "click",
        function () {

            currentMonth++;


            if (
                currentMonth > 11
            ) {

                currentMonth =
                    0;

                currentYear++;

            }


            renderCalendar();

        }
    );

}


// ============================================================
// 19. 메모
// ============================================================


// ====================
// 메모 표시
// ====================

function showMemos() {

    if (!memoList) {
        return;
    }


    clearElement(
        memoList
    );


    memos.forEach(
        function (memo) {

            const card =
                createElement(
                    "div",
                    "memo-card"
                );


            // 카드가 어떤 메모인지 기억
            card._memo = memo;


            // ====================
            // 드래그 손잡이
            // ====================

            const dragHandle =
                createElement(
                    "span",
                    "memo-drag-handle",
                    ":::"
                );


            dragHandle.draggable = true;


            card.appendChild(
                dragHandle
            );


            // ====================
            // 제목
            // ====================

            const title =
                createElement(
                    "h3",
                    "",
                    memo.title
                );


            // ====================
            // 미리보기
            // ====================

            const content =
                createElement(
                    "div",
                    "memo-preview"
                );


            content.innerHTML =
                memo.content || "";


            // ====================
            // 날짜
            // ====================

            const date =
                createElement(
                    "div",
                    "memo-date",
                    memo.date || ""
                );


            // ====================
            // ⋮ 메뉴
            // ====================

            const actionMenu =
                createActionMenu(
                    function () {
                        editMemo(memo);
                    },
                    function () {
                        const confirmed = confirm(`'${memo.title}' 메모를 삭제할까요?`);
                        if (!confirmed) return;
                        memos = memos.filter(function (currentMemo) {
                            return currentMemo !== memo;
                        });
                        saveMemos();
                        showMemos();
                    }
                );


            // ====================
            // 카드 내용
            // ====================

            card.appendChild(
                title
            );

            card.appendChild(
                content
            );

            card.appendChild(
                date
            );

            card.appendChild(
                actionMenu
            );


            // ====================
            // 메모 열기
            // ====================

            card.addEventListener(
                "click",
                function (event) {

                    if (
                        event.target.closest(".action-menu") ||
                        event.target.closest(".memo-drag-handle")
                    ) {
                        return;
                    }

                    openMemoViewer(memo);

                }
            );


            // ====================================================
            // 드래그 시작
            // ====================================================

            dragHandle.addEventListener(
                "dragstart",
                function (event) {

                    event.stopPropagation();


                    card.classList.add(
                        "dragging"
                    );


                    // 브라우저가 드래그 중이라는 것을 인식하도록
                    event.dataTransfer.effectAllowed =
                        "move";

                }
            );


            // ====================================================
            // 카드 위에서 이동
            // ====================================================

            card.addEventListener(
                "dragover",
                function (event) {

                    event.preventDefault();


                    const dragging =
                        memoList.querySelector(
                            ".dragging"
                        );


                    if (
                        !dragging ||
                        dragging === card
                    ) {
                        return;
                    }


                    const rect =
                        card.getBoundingClientRect();


                    const middleX =
                        rect.left +
                        rect.width / 2;


                    // 왼쪽 절반
                    if (
                        event.clientX <
                        middleX
                    ) {

                        memoList.insertBefore(
                            dragging,
                            card
                        );

                    }

                    // 오른쪽 절반
                    else {

                        memoList.insertBefore(
                            dragging,
                            card.nextSibling
                        );

                    }

                }
            );


            // ====================================================
            // 드래그 종료
            // ====================================================

            dragHandle.addEventListener(
                "dragend",
                function () {

                    card.classList.remove(
                        "dragging"
                    );


                    saveMemoOrder();

                }
            );


            memoList.appendChild(
                card
            );

        }
    );

}


// ============================================================
// 메모 드래그 순서 저장
// ============================================================

function saveMemoOrder() {

    const cards =
        memoList.querySelectorAll(
            ".memo-card"
        );


    const newMemos = [];


    cards.forEach(
        function (card) {

            newMemos.push(
                card._memo
            );

        }
    );


    memos =
        newMemos;


    saveMemos();

}


function editMemo(memo) {

    editingMemo =
        memo;


    memoTitle.value =
        memo.title || "";

    memoContent.innerHTML =
        memo.content || "";


    memoEditor.style.display =
        "block";


    memoTitle.focus();
}


if (newMemoButton) {

    newMemoButton.addEventListener(
        "click",
        function () {

            editingMemo =
                null;

            memoTitle.value =
                "";

            memoContent.innerHTML =
                "";


            memoEditor.style.display =
                "block";


            memoTitle.focus();

        }
    );

}


if (saveMemoButton) {

    saveMemoButton.addEventListener(
        "click",
        function () {

            const title =
                memoTitle.value.trim();

            const content =
                memoContent.innerHTML.trim();


            if (
                title === "" &&
                content === ""
            ) {
                return;
            }


            if (
                editingMemo === null
            ) {

                memos.push({

                    title:
                        title ||
                        "제목 없음",

                    content:
                        content,

                    date:
                        getTodayString()

                });

            }

            else {

                editingMemo.title =
                    title ||
                    "제목 없음";

                editingMemo.content =
                    content;

            }


            saveMemos();

            showMemos();


            memoEditor.style.display =
                "none";

            editingMemo =
                null;

        }
    );

}


if (cancelMemoButton) {

    cancelMemoButton.addEventListener(
        "click",
        function () {

            memoEditor.style.display =
                "none";

            editingMemo =
                null;

        }
    );

}

// ====================
// 메모 서식
// ====================

const memoBoldButton =
    getElement("memoBoldButton");


const memoItalicButton =
    getElement("memoItalicButton");


const memoUnderlineButton =
    getElement("memoUnderlineButton");


const memoFontSize =
    getElement("memoFontSize");


const memoTextColor =
    getElement("memoTextColor");


const memoBackgroundColor =
    getElement("memoBackgroundColor");


// ====================
// 메모 선택 영역 저장
// ====================

let memoSavedRange =
    null;


function saveMemoSelection() {

    const selection =
        window.getSelection();


    if (
        !selection ||
        selection.rangeCount === 0
    ) {

        return;

    }


    const range =
        selection.getRangeAt(0);


    // 메모 영역 안에서 선택한 경우에만 저장

    if (
        memoContent.contains(
            range.commonAncestorContainer
        )
    ) {

        memoSavedRange =
            range.cloneRange();

    }

}


// ====================
// 메모 선택 영역 복원
// ====================

function restoreMemoSelection() {

    if (
        memoSavedRange === null
    ) {

        return;

    }


    const selection =
        window.getSelection();


    selection.removeAllRanges();


    selection.addRange(
        memoSavedRange
    );

}


// ====================
// 서식 적용
// ====================

function applyMemoFormat(
    command,
    value = null
) {

    memoContent.focus();


    restoreMemoSelection();


    document.execCommand(
        command,
        false,
        value
    );


    saveMemoSelection();

}


// ====================
// 선택 영역 계속 기억
// ====================

document.addEventListener(
    "selectionchange",
    function () {

        saveMemoSelection();

    }
);


// ====================
// 굵게
// ====================

memoBoldButton.addEventListener(
    "mousedown",
    function (event) {

        event.preventDefault();

        saveMemoSelection();

        applyMemoFormat(
            "bold"
        );

    }
);


// ====================
// 기울임
// ====================

memoItalicButton.addEventListener(
    "mousedown",
    function (event) {

        event.preventDefault();

        saveMemoSelection();

        applyMemoFormat(
            "italic"
        );

    }
);


// ====================
// 밑줄
// ====================

memoUnderlineButton.addEventListener(
    "mousedown",
    function (event) {

        event.preventDefault();

        saveMemoSelection();

        applyMemoFormat(
            "underline"
        );

    }
);


// ====================
// 선택 영역 가져오기
// ====================

function getMemoSelectionRange() {

    const selection =
        window.getSelection();


    if (
        !selection ||
        selection.rangeCount === 0
    ) {

        return null;

    }


    return selection.getRangeAt(0);

}


// ====================
// 선택 영역에 스타일 적용
// ====================

function applyMemoStyle(
    styleName,
    styleValue
) {

    memoContent.focus();

    restoreMemoSelection();


    const selection =
        window.getSelection();


    if (
        !selection ||
        selection.rangeCount === 0 ||
        selection.isCollapsed
    ) {

        return;

    }


    const range =
        selection.getRangeAt(0);


    const span =
        document.createElement(
            "span"
        );


    span.style[styleName] =
        styleValue;


    span.appendChild(
        range.extractContents()
    );


    range.insertNode(
        span
    );


    selection.removeAllRanges();


    const newRange =
        document.createRange();


    newRange.selectNodeContents(
        span
    );


    selection.addRange(
        newRange
    );

    saveMemoSelection();

}

// ====================
// 글씨 크기 선택 영역 저장
// ====================

memoFontSize.addEventListener(
    "mousedown",
    function () {

        saveMemoSelection();

    }
);

// ====================
// 글씨 크기 변경
// 10px ~ 50px
// ====================

memoFontSize.addEventListener(
    "change",
    function () {

        let size =
            Number(
                memoFontSize.value
            );


        // 숫자가 아니면 기본 16px
        if (
            !Number.isFinite(size)
        ) {

            size = 16;

        }


        // 정수로 반올림
        size =
            Math.round(size);


        // 10~50px로 제한
        size =
            Math.min(
                Math.max(
                    size,
                    10
                ),
                50
            );


        // 입력칸도 보정된 값으로 변경
        memoFontSize.value =
            size;


        // 메모에 선택 영역 복원
        memoContent.focus();

        restoreMemoSelection();


        // 선택 영역에 임시 font 크기 적용
        document.execCommand(
            "fontSize",
            false,
            "7"
        );


        // 만들어진 <font size="7">을
        // 실제 px 크기로 변경
        const fonts =
            memoContent.querySelectorAll(
                'font[size="7"]'
            );


        fonts.forEach(
            function (font) {

                font.removeAttribute(
                    "size"
                );


                font.style.fontSize =
                    `${size}px`;

            }
        );


        saveMemoSelection();

    }
);

// ====================
// 글자색
// ====================

memoTextColor.addEventListener(
    "mousedown",
    function () {

        saveMemoSelection();

    }
);


memoTextColor.addEventListener(
    "change",
    function () {

        applyMemoStyle(
            "color",
            memoTextColor.value
        );

    }
);

// ====================
// 배경색
// ====================

memoBackgroundColor.addEventListener(
    "mousedown",
    function () {

        saveMemoSelection();

    }
);


memoBackgroundColor.addEventListener(
    "change",
    function () {

        memoContent.focus();

        restoreMemoSelection();


        document.execCommand(
            "hiliteColor",
            false,
            memoBackgroundColor.value
        );


        saveMemoSelection();

    }
);


// ============================================================
// 20. 일정 - Todo 연결 UI
// ============================================================

let scheduleTodoArea =
    null;

let scheduleTodoList =
    null;


function createScheduleTodoSelector() {

    if (!scheduleEditor) {
        return;
    }


    if (scheduleTodoArea) {
        scheduleTodoArea.remove();
    }


    scheduleTodoArea =
        createElement(
            "div",
            "schedule-todo-area"
        );


    const title =
        createElement(
            "div",
            "schedule-todo-title",
            "연결할 Todo"
        );


    scheduleTodoList =
        createElement(
            "div",
            "schedule-todo-list"
        );


    scheduleTodoArea.appendChild(
        title
    );


    scheduleTodoArea.appendChild(
        scheduleTodoList
    );


    // 기존에는 scheduleDescription을 기준으로
    // insertBefore 했지만,
    // 현재 HTML에서는 scheduleDescription이
    // .schedule-editor-extra 안에 있으므로
    // 그 부모 요소를 기준으로 삽입한다.

    const todoSlot =
        scheduleEditor.querySelector(
            ".schedule-editor-todo-slot"
        );

    if (todoSlot) {

        todoSlot.appendChild(
            scheduleTodoArea
        );

    }
}


function showScheduleTodoSelector() {

    if (!scheduleTodoList) {
        createScheduleTodoSelector();
    }


    clearElement(
        scheduleTodoList
    );


    let count = 0;


    categories.forEach(
        function (category) {

            category.todos.forEach(
                function (todo) {

                    // 현재 일정 날짜에 표시되는 Todo만
                    if (
                        !todoAppearsOnDate(
                            todo,
                            selectedDate
                        )
                    ) {
                        return;
                    }


                    count++;


                    const label =
                        createElement(
                            "label",
                            "schedule-todo-option"
                        );

                    const colorDot =
                        createElement(
                            "span",
                            "schedule-todo-color"
                        );

                    colorDot.style.backgroundColor =
                        category.color ||
                        getDefaultCategoryColor(categories.indexOf(category));


                    const checkbox =
                        createElement(
                            "input"
                        );


                    checkbox.type =
                        "checkbox";


                    checkbox.checked =
                        selectedScheduleTodoIds.includes(
                            todo.id
                        );


                    checkbox.addEventListener(
                        "change",
                        function () {

                            if (
                                checkbox.checked
                            ) {

                                if (
                                    !selectedScheduleTodoIds.includes(
                                        todo.id
                                    )
                                ) {

                                    selectedScheduleTodoIds.push(
                                        todo.id
                                    );

                                }

                                // 연결한 Todo의 카테고리 색을
                                // 일정 색상에 자동 적용한다.
                                if (scheduleColor) {
                                    scheduleColor.value =
                                        category.color ||
                                        getDefaultCategoryColor(categories.indexOf(category));
                                }

                            }

                            else {

                                selectedScheduleTodoIds =
                                    selectedScheduleTodoIds.filter(
                                        function (id) {

                                            return (
                                                id !==
                                                todo.id
                                            );

                                        }
                                    );

                            }

                        }
                    );


                    label.appendChild(
                        checkbox
                    );

                    label.appendChild(
                        colorDot
                    );


                    label.appendChild(
                        document.createTextNode(
                            `${category.name} · ${todo.text}`
                        )
                    );


                    scheduleTodoList.appendChild(
                        label
                    );

                }
            );

        }
    );


    if (count === 0) {

        const empty =
            createElement(
                "div",
                "",
                "이 날짜에 연결할 Todo가 없습니다."
            );


        scheduleTodoList.appendChild(
            empty
        );

    }
}


function getTodosForSchedule(
    scheduleId,
    dateString
) {

    const result = [];


    categories.forEach(
        function (category) {

            category.todos.forEach(
                function (todo) {

                    const linkedByTodo =
                        todo.scheduleId ===
                        scheduleId;


                    const schedule =
                        schedules.find(
                            function (item) {

                                return (
                                    item.id ===
                                    scheduleId
                                );

                            }
                        );


                    const linkedBySchedule =
                        schedule &&
                        Array.isArray(
                            schedule.todoIds
                        ) &&
                        schedule.todoIds.includes(
                            todo.id
                        );


                    if (
                        (
                            linkedByTodo ||
                            linkedBySchedule
                        ) &&
                        todoAppearsOnDate(
                            todo,
                            dateString
                        )
                    ) {

                        result.push({

                            category:
                                category,

                            todo:
                                todo

                        });

                    }

                }
            );

        }
    );


    return result;
}


// ============================================================
// 21. 일정
// ============================================================

function isScheduleForDate(
    schedule,
    targetDate
) {

    const repeat =
        schedule.repeat ||
        "none";


    if (
        repeat === "none"
    ) {

        return (
            schedule.date ===
            targetDate
        );

    }


    if (
        targetDate <
        schedule.date
    ) {

        return false;

    }


    if (
        repeat === "daily"
    ) {

        return true;

    }


    if (
        repeat === "weekly"
    ) {

        const scheduleDate =
            new Date(
                schedule.date +
                "T00:00:00"
            );


        const target =
            new Date(
                targetDate +
                "T00:00:00"
            );


        return (
            scheduleDate.getDay() ===
            target.getDay()
        );

    }


    return false;
}


function showSchedules() {

    if (!scheduleList) {
        return;
    }


    clearElement(
        scheduleList
    );


    const visibleSchedules =
        schedules
            .filter(
                function (schedule) {

                    return isScheduleForDate(
                        schedule,
                        selectedDate
                    );

                }
            )
            .sort(
                function (a, b) {

                    return (
                        (a.startTime || "")
                            .localeCompare(
                                b.startTime || ""
                            )
                    );

                }
            );


    visibleSchedules.forEach(
        function (schedule) {

            const card =
                createElement(
                    "div",
                    "schedule-card"
                );


            card.style.borderLeftColor =
                schedule.color ||
                "#4a90e2";


            const title =
                createElement(
                    "div",
                    "schedule-card-title",
                    schedule.title || ""
                );


            const time =
                createElement(
                    "div",
                    "schedule-card-time",
                    `${schedule.startTime || ""} ~ ${schedule.endTime || ""}`
                );


            card.appendChild(title);
            card.appendChild(time);


            if (
                schedule.description
            ) {

                card.appendChild(
                    createElement(
                        "div",
                        "schedule-card-description",
                        schedule.description
                    )
                );

            }


            // --------------------
            // 연결 Todo
            // --------------------

            const linkedTodos =
                getTodosForSchedule(
                    schedule.id,
                    selectedDate
                );


            if (
                linkedTodos.length > 0
            ) {

                const linkedArea =
                    createElement(
                        "div",
                        "schedule-linked-todos"
                    );


                linkedTodos.forEach(
                    function (data) {

                        const completed =
                            isTodoCompletedOnDate(
                                data.todo,
                                selectedDate
                            );


                        const todoText =
                            createElement(
                                "div"
                            );


                        todoText.textContent =
                            completed
                                ? `✓ ${data.todo.text}`
                                : `□ ${data.todo.text}`;


                        if (completed) {

                            todoText.style.textDecoration =
                                "line-through";

                        }


                        linkedArea.appendChild(
                            todoText
                        );

                    }
                );


                card.appendChild(
                    linkedArea
                );

            }


            const actionMenu =
                createActionMenu(
                    function () {
                        editSchedule(schedule);
                    },
                    function () {
                        deleteSchedule(schedule);
                    }
                );

            card.appendChild(
                actionMenu
            );


            scheduleList.appendChild(
                card
            );

        }
    );


    drawScheduleArcs();
}


// ============================================================
// 22. 일정 새로 만들기
// ============================================================

function openNewScheduleEditor() {

    editingSchedule =
        null;


    editingScheduleId =
        createScheduleId();


    selectedScheduleTodoIds =
        [];


    if (scheduleTitle) {
        scheduleTitle.value = "";
    }

    if (scheduleStart) {
        scheduleStart.value = "09:00";
    }

    if (scheduleEnd) {
        scheduleEnd.value = "10:00";
    }

    if (scheduleColor) {
        scheduleColor.value = "#4a90e2";
    }

    if (scheduleDescription) {
        scheduleDescription.value = "";
    }


    showScheduleTodoSelector();


    scheduleEditor.style.display =
        "block";


    scheduleTitle.focus();
}


if (newScheduleButton) {

    newScheduleButton.addEventListener(
        "click",
        openNewScheduleEditor
    );

}


// ============================================================
// 23. 일정 수정
// ============================================================

function editSchedule(
    schedule
) {

    editingSchedule =
        schedule;


    editingScheduleId =
        schedule.id;


    // --------------------
    // 연결 Todo
    // --------------------

    selectedScheduleTodoIds =
        Array.isArray(
            schedule.todoIds
        )
            ? [...schedule.todoIds]
            : [];


    // 기존 Todo의 scheduleId도 확인
    categories.forEach(
        function (category) {

            category.todos.forEach(
                function (todo) {

                    if (
                        todo.scheduleId ===
                        schedule.id
                    ) {

                        if (
                            !selectedScheduleTodoIds.includes(
                                todo.id
                            )
                        ) {

                            selectedScheduleTodoIds.push(
                                todo.id
                            );

                        }

                    }

                }
            );

        }
    );


    scheduleTitle.value =
        schedule.title || "";

    if (scheduleStart) {
        scheduleStart.value =
            schedule.startTime || "09:00";
    }

    if (scheduleEnd) {
        scheduleEnd.value =
            schedule.endTime || "10:00";
    }

    scheduleColor.value =
        schedule.color ||
        "#4a90e2";

    scheduleDescription.value =
        schedule.description || "";


    showScheduleTodoSelector();


    scheduleEditor.style.display =
        "block";


    scheduleTitle.focus();
}


// ============================================================
// 24. 일정 저장
// ============================================================

if (saveScheduleButton) {

    saveScheduleButton.addEventListener(
        "click",
        function () {

            const title =
                scheduleTitle.value.trim();

            const start =
                scheduleStart ? scheduleStart.value : "";

            const end =
                scheduleEnd ? scheduleEnd.value : "";


            if (
                title === "" ||
                start === "" ||
                end === ""
            ) {

                alert(
                    "일정 제목과 시간을 입력해주세요."
                );

                return;
            }


            if (
                start >= end
            ) {

                alert(
                    "종료 시간은 시작 시간보다 늦어야 합니다."
                );

                return;
            }


            const scheduleData = {

                id:
                    editingScheduleId,

                title:
                    title,

                date:
                    editingSchedule === null
                        ? selectedDate
                        : editingSchedule.date,

                startTime:
                    start,

                endTime:
                    end,

                color:
                    scheduleColor.value,

                description:
                    scheduleDescription.value.trim(),

                repeat:
                    scheduleRepeat.value,

                todoIds:
                    [...selectedScheduleTodoIds]

            };


            // --------------------
            // 새 일정
            // --------------------

            if (
                editingSchedule === null
            ) {

                schedules.push(
                    scheduleData
                );

            }

            // --------------------
            // 기존 일정
            // --------------------

            else {

                Object.assign(
                    editingSchedule,
                    scheduleData
                );

            }


            // =================================================
            // Todo ↔ 일정 연결 동기화
            // =================================================

            categories.forEach(
                function (category) {

                    category.todos.forEach(
                        function (todo) {

                            if (
                                selectedScheduleTodoIds.includes(
                                    todo.id
                                )
                            ) {

                                todo.scheduleId =
                                    editingScheduleId;

                            }

                            else if (
                                todo.scheduleId ===
                                editingScheduleId
                            ) {

                                todo.scheduleId =
                                    null;

                            }

                        }
                    );

                }
            );


            saveSchedules();
            saveCategories();


            scheduleEditor.style.display =
                "none";


            editingSchedule =
                null;

            editingScheduleId =
                null;

            selectedScheduleTodoIds =
                [];


            showSchedules();
            showTodos();
            renderCalendar();

        }
    );

}


// ============================================================
// 25. 일정 삭제
// ============================================================


function deleteSchedule(schedule) {

    if (!schedule) return;

    const confirmed =
        confirm(`"${schedule.title}" 일정을 삭제할까요?`);

    if (!confirmed) return;

    const deletedId = schedule.id;

    schedules = schedules.filter(function (item) {
        return item.id !== deletedId;
    });

    categories.forEach(function (category) {
        category.todos.forEach(function (todo) {
            if (todo.scheduleId === deletedId) {
                todo.scheduleId = null;
            }
        });
    });

    saveSchedules();
    saveCategories();

    selectedScheduleTodoIds = [];
    scheduleEditor.style.display = "none";
    editingSchedule = null;
    editingScheduleId = null;

    showSchedules();
    showTodos();
    renderCalendar();
}


if (cancelScheduleButton) {

    cancelScheduleButton.addEventListener(
        "click",
        function () {

            scheduleEditor.style.display =
                "none";


            editingSchedule =
                null;

            editingScheduleId =
                null;

            selectedScheduleTodoIds =
                [];

        }
    );

}


// ============================================================
// 26. 일정 시간 / 24시간 시계
// ============================================================

function timeToMinutes(time) {

    if (
        typeof time !==
        "string" ||
        !time.includes(":")
    ) {
        return 0;
    }


    const parts =
        time.split(":");


    return (
        Number(parts[0]) * 60 +
        Number(parts[1])
    );
}


function createClockNumbers() {

    if (!clockNumbers) {
        return;
    }


    clearElement(
        clockNumbers
    );


    const center = 50;
    const radius = 40;


    for (
        let hour = 0;
        hour < 24;
        hour++
    ) {

        const number =
            createElement(
                "div",
                "clock-number",
                String(hour)
            );


        const angle =
            (hour / 24) * 360;


        const rad =
            (angle - 90) *
            Math.PI /
            180;


        const x =
            center +
            radius *
            Math.cos(rad);


        const y =
            center +
            radius *
            Math.sin(rad);


        number.style.left =
            `${x}%`;

        number.style.top =
            `${y}%`;


        clockNumbers.appendChild(
            number
        );

    }
}


function createClockTicks() {

    if (!clockTicks) {
        return;
    }


    clearElement(
        clockTicks
    );


    for (
        let hour = 0;
        hour < 24;
        hour++
    ) {

        const tick =
            createElement(
                "div",
                "clock-tick"
            );


        const angle =
            (hour / 24) * 360;


        tick.style.transform =
            `rotate(${angle}deg)`;


        clockTicks.appendChild(
            tick
        );

    }
}


function updateScheduleClock() {

    if (!hourHand) {
        return;
    }


    const now =
        new Date();


    const totalMinutes =
        now.getHours() * 60 +
        now.getMinutes() +
        now.getSeconds() / 60;


    const angle =
        (totalMinutes / 1440) * 360;


    hourHand.style.transform =
        `rotate(${angle}deg)`;
}


// ============================================================
// 27. 일정 Arc
// ============================================================

function drawScheduleArcs() {

    if (!scheduleArcs) {
        return;
    }


    clearElement(
        scheduleArcs
    );


    const todaySchedules =
        schedules.filter(
            function (schedule) {

                return isScheduleForDate(
                    schedule,
                    selectedDate
                );

            }
        );


    todaySchedules.forEach(
        function (schedule) {

            const start =
                timeToMinutes(
                    schedule.startTime
                );


            const end =
                timeToMinutes(
                    schedule.endTime
                );


            const startAngle =
                (start / 1440) *
                360;


            const endAngle =
                (end / 1440) *
                360;


            const svg =
                document.createElementNS(
                    "http://www.w3.org/2000/svg",
                    "svg"
                );


            svg.setAttribute(
                "viewBox",
                "0 0 380 380"
            );


            svg.classList.add(
                "schedule-arc"
            );


            const center = 190;
            const radius = 150;


            function polarToCartesian(
                angle
            ) {

                const rad =
                    (angle - 90) *
                    Math.PI /
                    180;


                return {

                    x:
                        center +
                        radius *
                        Math.cos(rad),

                    y:
                        center +
                        radius *
                        Math.sin(rad)

                };

            }


            const startPoint =
                polarToCartesian(
                    startAngle
                );


            const endPoint =
                polarToCartesian(
                    endAngle
                );


            const arcSize =
                endAngle -
                startAngle;


            const largeArcFlag =
                arcSize <= 180
                    ? "0"
                    : "1";


            const path =
                document.createElementNS(
                    "http://www.w3.org/2000/svg",
                    "path"
                );


            const pathData = `
                M ${center} ${center}
                L ${startPoint.x} ${startPoint.y}
                A ${radius} ${radius}
                  0 ${largeArcFlag} 1
                  ${endPoint.x} ${endPoint.y}
                Z
            `;


            path.setAttribute(
                "d",
                pathData
            );


            path.setAttribute(
                "fill",
                schedule.color ||
                "#4a90e2"
            );


            path.setAttribute(
                "fill-opacity",
                "0.25"
            );


            svg.appendChild(
                path
            );


            scheduleArcs.appendChild(
                svg
            );

        }
    );
}


// ============================================================
// 28. D-Day
// ============================================================

function calculateDday(
    targetDate
) {

    const currentDate =
        new Date();


    const target =
        new Date(
            targetDate +
            "T00:00:00"
        );


    currentDate.setHours(
        0,
        0,
        0,
        0
    );


    return Math.round(
        (
            target -
            currentDate
        ) /
        (
            1000 *
            60 *
            60 *
            24
        )
    );
}


function getDdayText(number) {

    if (
        number === 0
    ) {
        return "D-Day";
    }


    if (
        number > 0
    ) {
        return `D-${number}`;
    }


    return `D+${Math.abs(number)}`;
}


// ============================================================
// D-Day 드래그
// ============================================================

let draggingDday = null;


// ============================================================
// D-Day 표시
// ============================================================

function showDDays() {

    if (!ddayList) {
        return;
    }


    clearElement(
        ddayList
    );


    dDays.forEach(
        function (dday) {

            // ====================
            // 카드
            // ====================

            const card =
                createElement(
                    "div",
                    "dday-card"
                );

            card._dday = dday;


            // ====================
            // 드래그 핸들
            // ====================

            const dragHandle =
                createElement(
                    "span",
                    "dday-drag-handle",
                    ":::"
                );


            dragHandle.draggable =
                true;


            // ====================
            // 제목
            // ====================

            const title =
                createElement(
                    "h3",
                    "",
                    dday.title
                );


            // ====================
            // 날짜
            // ====================

            const date =
                createElement(
                    "div",
                    "dday-date",
                    dday.date
                );


            // ====================
            // D-Day 숫자
            // ====================

            const number =
                createElement(
                    "div",
                    "dday-number",
                    getDdayText(
                        calculateDday(
                            dday.date
                        )
                    )
                );



            // ====================
            // ⋮ 메뉴
            // ====================

            const actionMenu =
                createActionMenu(
                    function () {
                        editDday(dday);
                    },
                    function () {
                        const confirmed = confirm(`'${dday.title}' D-Day를 삭제할까요?`);
                        if (!confirmed) return;
                        dDays = dDays.filter(function (currentDday) {
                            return currentDday !== dday;
                        });
                        saveDDays();
                        showDDays();
                    }
                );


            // ====================================================
            // 카드에 요소 넣기
            // ====================================================

            card.appendChild(
                title
            );

            card.appendChild(
                date
            );

            card.appendChild(
                number
            );

            card.appendChild(
                actionMenu
            );


            card.appendChild(
                dragHandle
            );


            // ====================================================
            // 드래그 시작
            // ====================================================

            dragHandle.addEventListener(
                "dragstart",
                function (event) {

                    event.stopPropagation();


                    draggingDday =
                        dday;


                    card.classList.add(
                        "dragging"
                    );


                    event.dataTransfer.effectAllowed =
                        "move";

                }
            );


            // ====================================================
            // 드래그 중
            // ====================================================

            card.addEventListener(
                "dragover",
                function (event) {

                    event.preventDefault();


                    const dragging =
                        ddayList.querySelector(
                            ".dragging"
                        );


                    if (
                        !dragging ||
                        dragging === card
                    ) {
                        return;
                    }


                    const rect =
                        card.getBoundingClientRect();


                    const middleX =
                        rect.left +
                        rect.width / 2;


                    // 왼쪽 절반
                    if (
                        event.clientX <
                        middleX
                    ) {

                        ddayList.insertBefore(
                            dragging,
                            card
                        );

                    }


                    // 오른쪽 절반
                    else {

                        ddayList.insertBefore(
                            dragging,
                            card.nextSibling
                        );

                    }

                }
            );


            // ====================================================
            // 드래그 종료
            // ====================================================

            dragHandle.addEventListener(
                "dragend",
                function () {

                    card.classList.remove(
                        "dragging"
                    );


                    // 실제 배열 순서 변경
                    if (
                        draggingDday !== null
                    ) {

                        const cards =
                            Array.from(
                                ddayList.children
                            );


                        const newDDays =
                            [];


                        cards.forEach(
                            function (currentCard) {

                                const titleElement =
                                    currentCard.querySelector(
                                        "h3"
                                    );


                                if (
                                    !titleElement
                                ) {
                                    return;
                                }


                                const foundDday =
                                    dDays.find(
                                        function (item) {

                                            return (
                                                item.title ===
                                                titleElement.textContent
                                            );

                                        }
                                    );


                                if (
                                    foundDday
                                ) {

                                    newDDays.push(
                                        foundDday
                                    );

                                }

                            }
                        );


                        if (
                            newDDays.length ===
                            dDays.length
                        ) {

                            dDays =
                                newDDays;


                            saveDDays();

                        }

                    }


                    draggingDday =
                        null;

                }
            );


            // ====================================================
            // 카드 추가
            // ====================================================

            ddayList.appendChild(
                card
            );

        }
    );
}


// ============================================================
// D-Day 수정
// ============================================================

function editDday(dday) {

    editingDday =
        dday;


    ddayTitle.value =
        dday.title || "";


    ddayDate.value =
        dday.date || "";


    ddayDate.min =
        getTodayString();


    ddayEditor.style.display =
        "block";


    ddayTitle.focus();

}


// ============================================================
// 새 D-Day
// ============================================================

if (newDdayButton) {

    newDdayButton.addEventListener(
        "click",
        function () {

            editingDday =
                null;


            ddayTitle.value =
                "";


            ddayDate.value =
                "";


            ddayDate.min =
                getTodayString();


            ddayEditor.style.display =
                "block";


            ddayTitle.focus();

        }
    );

}


// ============================================================
// D-Day 저장
// ============================================================

if (saveDdayButton) {

    saveDdayButton.addEventListener(
        "click",
        function () {

            const title =
                ddayTitle.value.trim();


            const date =
                ddayDate.value;


            if (
                title === "" ||
                date === ""
            ) {
                return;
            }


            if (
                date <
                getTodayString()
            ) {

                alert(
                    "지난 날짜는 D-Day로 설정할 수 없습니다."
                );


                return;

            }


            // 새 D-Day
            if (
                editingDday === null
            ) {

                dDays.push({

                    title:
                        title,

                    date:
                        date

                });

            }


            // 기존 D-Day 수정
            else {

                editingDday.title =
                    title;


                editingDday.date =
                    date;

            }


            saveDDays();

            showDDays();


            ddayEditor.style.display =
                "none";


            editingDday =
                null;

        }
    );

}


// ============================================================
// D-Day 취소
// ============================================================

if (cancelDdayButton) {

    cancelDdayButton.addEventListener(
        "click",
        function () {

            ddayEditor.style.display =
                "none";


            editingDday =
                null;

        }
    );

}


// ============================================================
// 29. 프로젝트
// ============================================================

const taskList =
    createElement(
        "div",
        "project-task-list"
    );

function getProjectProgress(
    project
) {

    const tasks =
        Array.isArray(
            project.tasks
        )
            ? project.tasks
            : [];


    if (
        tasks.length === 0
    ) {
        return 0;
    }


    const completed =
        tasks.filter(
            function (task) {

                return (
                    task.completed ===
                    true
                );

            }
        ).length;


    return Math.round(
        completed /
        tasks.length *
        100
    );
}


function showProjects() {

    const oldProjectSort = document.getElementById("projectSort");
    if (oldProjectSort) {
        oldProjectSort.style.display = "none";
    }


    if (!projectList) return;

    clearElement(projectList);

    projects.forEach(function (project, index) {

        const item = createElement("div", "project-item");
        item._project = project;

        const dragHandle = createElement("span", "project-drag-handle", ":::");
        dragHandle.draggable = true;

        const title = createElement("h3", "", project.name);

        let dateText = "";
        if (project.startDate && project.endDate) dateText = `${project.startDate} ~ ${project.endDate}`;
        else if (project.startDate) dateText = `${project.startDate} ~`;
        else if (project.endDate) dateText = `~ ${project.endDate}`;

        const date = createElement("p", "project-date-text", dateText);

        const progress = getProjectProgress(project);
        const progressInfo = createElement("div", "project-progress-info");
        progressInfo.appendChild(createElement("span", "", "진행률"));
        progressInfo.appendChild(createElement("span", "", `${progress}%`));

        const progressBar = createElement("div", "project-progress-bar");
        const progressFill = createElement("div", "project-progress-fill");
        progressFill.style.width = `${progress}%`;
        progressBar.appendChild(progressFill);

        const taskList = createElement("div", "project-task-list");
        const tasks = Array.isArray(project.tasks) ? project.tasks : [];

        tasks.forEach(function (task) {
            const label = createElement("label");
            const checkbox = createElement("input");
            checkbox.type = "checkbox";
            checkbox.checked = task.completed === true;

            checkbox.addEventListener("click", function (event) {
                event.stopPropagation();
            });

            checkbox.addEventListener("change", function () {
                task.completed = checkbox.checked;
                saveProjects();
                showProjects();
            });

            label.appendChild(checkbox);
            label.appendChild(document.createTextNode(` ${task.text}`));
            taskList.appendChild(label);
        });

        const actionMenu = createActionMenu(
            function () { editProject(project, index); },
            function () { deleteProject(index); }
        );

        item.appendChild(dragHandle);
        item.appendChild(title);
        if (dateText !== "") item.appendChild(date);
        item.appendChild(progressInfo);
        item.appendChild(progressBar);
        item.appendChild(taskList);
        item.appendChild(actionMenu);

        dragHandle.addEventListener("dragstart", function (event) {
            event.stopPropagation();
            item.classList.add("dragging");
            event.dataTransfer.effectAllowed = "move";
        });

        item.addEventListener("dragover", function (event) {
            event.preventDefault();
            const dragging = projectList.querySelector(".project-item.dragging");
            if (!dragging || dragging === item) return;

            const rect = item.getBoundingClientRect();
            const middleX = rect.left + rect.width / 2;

            if (event.clientX < middleX) projectList.insertBefore(dragging, item);
            else projectList.insertBefore(dragging, item.nextSibling);
        });

        dragHandle.addEventListener("dragend", function () {
            item.classList.remove("dragging");
            saveProjectOrder();
        });

        projectList.appendChild(item);
    });
}

function saveProjectOrder() {
    const items = Array.from(projectList.querySelectorAll(".project-item"));
    const newProjects = [];

    items.forEach(function (item) {
        if (item._project) newProjects.push(item._project);
    });

    if (newProjects.length === projects.length) {
        projects = newProjects;
        saveProjects();
    }
}



function editProject(
    project,
    index
) {

    editingProjectIndex =
        index;


    projectTitle.value =
        project.name || "";

    projectStartDate.value =
        project.startDate || "";

    projectEndDate.value =
        project.endDate || "";


    projectItems.value =
        (
            Array.isArray(
                project.tasks
            )
                ? project.tasks
                : []
        )
            .map(
                function (task) {
                    return task.text;
                }
            )
            .join("\n");


    projectEditor.style.display =
        "block";


    projectTitle.focus();
}


function deleteProject(index) {

    const project =
        projects[index];


    if (!project) {
        return;
    }


    const confirmed =
        confirm(
            `"${project.name}" 프로젝트를 삭제할까요?`
        );


    if (!confirmed) {
        return;
    }


    projects.splice(
        index,
        1
    );


    saveProjects();

    showProjects();
}


if (newProjectButton) {

    newProjectButton.addEventListener(
        "click",
        function () {

            editingProjectIndex =
                null;


            projectTitle.value =
                "";

            projectStartDate.value =
                "";

            projectEndDate.value =
                "";

            projectItems.value =
                "";


            projectEditor.style.display =
                "block";


            projectTitle.focus();

        }
    );

}


if (saveProjectButton) {

    saveProjectButton.addEventListener(
        "click",
        function () {

            const name =
                projectTitle.value.trim();

            const startDate =
                projectStartDate.value;

            const endDate =
                projectEndDate.value;

            const taskText =
                projectItems.value.trim();


            if (
                name === ""
            ) {

                alert(
                    "프로젝트 이름을 입력해주세요."
                );

                return;
            }


            const taskLines =
                taskText === ""
                    ? []
                    : taskText
                        .split("\n")
                        .map(
                            function (text) {
                                return text.trim();
                            }
                        )
                        .filter(
                            function (text) {
                                return text !== "";
                            }
                        );


            let oldTasks = [];


            if (
                editingProjectIndex !==
                null &&
                projects[
                editingProjectIndex
                ]
            ) {

                oldTasks =
                    projects[
                        editingProjectIndex
                    ].tasks || [];

            }


            // 기존 완료 상태 보존
            const tasks =
                taskLines.map(
                    function (text) {

                        const oldTask =
                            oldTasks.find(
                                function (task) {

                                    return (
                                        task.text ===
                                        text
                                    );

                                }
                            );


                        return {

                            text:
                                text,

                            completed:
                                oldTask
                                    ? oldTask.completed === true
                                    : false

                        };

                    }
                );


            const project = {

                name:
                    name,

                startDate:
                    startDate,

                endDate:
                    endDate,

                tasks:
                    tasks

            };


            if (
                editingProjectIndex ===
                null
            ) {

                projects.push(
                    project
                );

            }

            else {

                projects[
                    editingProjectIndex
                ] =
                    project;

            }


            saveProjects();

            showProjects();


            projectEditor.style.display =
                "none";


            editingProjectIndex =
                null;

        }
    );

}


if (cancelProjectButton) {

    cancelProjectButton.addEventListener(
        "click",
        function () {

            projectEditor.style.display =
                "none";


            editingProjectIndex =
                null;

        }
    );

}


// ============================================================
// 30. 공부시간
// ============================================================

function formatStudyTime(
    totalSeconds
) {

    totalSeconds =
        Math.max(
            0,
            Math.floor(
                Number(totalSeconds) || 0
            )
        );


    const hours =
        Math.floor(
            totalSeconds / 3600
        );


    const minutes =
        Math.floor(
            (totalSeconds % 3600) /
            60
        );


    const seconds =
        totalSeconds % 60;


    if (
        hours > 0
    ) {

        return (
            `${hours}시간 ` +
            `${minutes}분 ` +
            `${seconds}초`
        );

    }


    if (
        minutes > 0
    ) {

        return (
            `${minutes}분 ` +
            `${seconds}초`
        );

    }


    return `${seconds}초`;
}


function getStudySecondsForDate(
    dateString,
    categoryName = null
) {

    return studyRecords.reduce(
        function (total, record) {

            if (
                record.date !==
                dateString
            ) {
                return total;
            }


            if (
                categoryName !== null &&
                record.category !==
                categoryName
            ) {
                return total;
            }


            return (
                total +
                (
                    Number(
                        record.seconds
                    ) || 0
                )
            );

        },
        0
    );
}


function getStudySecondsForRange(
    startDate,
    endDate
) {

    return studyRecords.reduce(
        function (total, record) {

            if (
                record.date <
                startDate ||
                record.date >
                endDate
            ) {
                return total;
            }


            return (
                total +
                (
                    Number(
                        record.seconds
                    ) || 0
                )
            );

        },
        0
    );
}


// ============================================================
// 31. 스톱워치
// ============================================================

let stopwatchSeconds =
    0;

let stopwatchInterval =
    null;

let stopwatchRunning =
    false;

let stopwatchCurrentCategory =
    "";


// 스톱워치 집중 모드: 수동 정지/초기화 전까지 앱 내부 이동을 막는다.
let stopwatchAutoPaused =
    false;


function updateStopwatchDisplay() {

    if (!stopwatchDisplay) {
        return;
    }


    const hours =
        Math.floor(
            stopwatchSeconds / 3600
        );


    const minutes =
        Math.floor(
            (stopwatchSeconds % 3600) /
            60
        );


    const seconds =
        stopwatchSeconds % 60;


    stopwatchDisplay.textContent =
        `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
}


function updateStopwatchCategoryColor() {
    if (!stopwatchCategory) return;

    let dot = document.getElementById("stopwatchCategoryColor");

    if (!dot) {
        dot = createElement("span", "stopwatch-category-color");
        dot.id = "stopwatchCategoryColor";
        stopwatchCategory.parentElement.insertBefore(dot, stopwatchCategory);
    }

    const category = getCategoryByName(stopwatchCategory.value);

    dot.style.backgroundColor =
        category
            ? (category.color || getDefaultCategoryColor(categories.indexOf(category)))
            : "transparent";
}

function loadStopwatchCategories() {

    if (!stopwatchCategory) {
        return;
    }


    const currentValue =
        stopwatchRunning
            ? stopwatchCurrentCategory
            : stopwatchCategory.value;


    clearElement(
        stopwatchCategory
    );


    const defaultOption =
        createElement(
            "option"
        );


    defaultOption.value =
        "";

    defaultOption.textContent =
        "카테고리 선택";

    defaultOption.disabled =
        true;


    stopwatchCategory.appendChild(
        defaultOption
    );


    categories.forEach(
        function (category) {

            const option =
                createElement(
                    "option"
                );


            option.value =
                category.name;

            option.textContent =
                category.name;


            stopwatchCategory.appendChild(
                option
            );

        }
    );


    if (
        currentValue &&
        categories.some(
            function (category) {
                return (
                    category.name ===
                    currentValue
                );
            }
        )
    ) {

        stopwatchCategory.value =
            currentValue;

    }

    else {

        stopwatchCategory.value =
            "";

    }

    updateStopwatchCategoryColor();
}


function saveCurrentStudyRecord() {

    if (
        stopwatchSeconds <= 0 ||
        stopwatchCurrentCategory === ""
    ) {
        return;
    }


    studyRecords.push({

        date:
            getTodayString(),

        seconds:
            stopwatchSeconds,

        category:
            stopwatchCurrentCategory

    });


    saveStudyRecords();

    showStudyRecords();

    showStudyStats();
}


function startStopwatch() {

    if (
        stopwatchRunning
    ) {

        clearInterval(
            stopwatchInterval
        );

        stopwatchInterval =
            null;

        stopwatchRunning =
            false;

        stopwatchAutoPaused =
            false;

        saveCurrentStudyRecord();

        // 기존 동작 그대로 종료 후 시간을 초기화한다.
        stopwatchSeconds = 0;

        updateStopwatchDisplay();

        stopwatchStartButton.textContent =
            "시작";

        stopwatchCategory.disabled =
            false;

        if (stopwatchDisplay) {
            stopwatchDisplay.title = "";
        }

        return;
    }


    // 페이지 이탈로 자동 일시정지된 경우 같은 카테고리로 이어서 시작한다.
    if (
        stopwatchAutoPaused
    ) {

        stopwatchRunning =
            true;

        stopwatchAutoPaused =
            false;

        stopwatchCategory.disabled =
            true;

        stopwatchStartButton.textContent =
            "정지";

        if (stopwatchDisplay) {
            stopwatchDisplay.title = "";
        }

        stopwatchInterval =
            setInterval(
                function () {
                    stopwatchSeconds++;
                    updateStopwatchDisplay();
                },
                1000
            );

        return;
    }


    if (
        !stopwatchCategory.value
    ) {

        alert(
            "공부할 카테고리를 선택하세요."
        );

        return;
    }


    stopwatchCurrentCategory =
        stopwatchCategory.value;


    stopwatchRunning =
        true;

    stopwatchAutoPaused =
        false;


    stopwatchCategory.disabled =
        true;


    stopwatchStartButton.textContent =
        "정지";


    stopwatchInterval =
        setInterval(
            function () {

                stopwatchSeconds++;

                updateStopwatchDisplay();

            },
            1000
        );
}


function resetStopwatch() {

    clearInterval(
        stopwatchInterval
    );

    stopwatchInterval =
        null;


    stopwatchSeconds =
        0;


    stopwatchRunning =
        false;

    stopwatchAutoPaused =
        false;

    stopwatchCurrentCategory =
        "";


    // ============================================================
// 스톱워치 집중 모드
// ============================================================

function isStopwatchFocusActive() {
    return stopwatchRunning || stopwatchAutoPaused;
}

function pauseStopwatchByLeavingPage() {
    if (!stopwatchRunning) {
        return;
    }

    clearInterval(stopwatchInterval);
    stopwatchInterval = null;

    stopwatchRunning = false;
    stopwatchAutoPaused = true;

    if (stopwatchStartButton) {
        stopwatchStartButton.textContent = "재개";
    }

    if (stopwatchDisplay) {
        stopwatchDisplay.title =
            "집중 모드: 다른 탭이나 앱으로 이동하여 일시정지되었습니다.";
    }

    console.log("스톱워치 집중 모드: 자동 일시정지");
}

// 다른 탭/앱으로 이동하면 스톱워치를 자동 일시정지한다.
document.addEventListener("visibilitychange", function () {
    if (
        document.visibilityState === "hidden" &&
        stopwatchRunning
    ) {
        pauseStopwatchByLeavingPage();
    }
});

// 새로고침/탭 닫기 시에는 브라우저 이탈 경고를 요청한다.
window.addEventListener("beforeunload", function (event) {
    if (!isStopwatchFocusActive()) {
        return;
    }

    event.preventDefault();
    event.returnValue = "";
});


if (stopwatchCategory) {

        stopwatchCategory.disabled =
            false;

        stopwatchCategory.value =
            "";

    }


    if (stopwatchStartButton) {

        stopwatchStartButton.textContent =
            "시작";

    }

    if (stopwatchDisplay) {
        stopwatchDisplay.title = "";
    }


    updateStopwatchDisplay();
}


if (stopwatchCategory) {

        stopwatchCategory.disabled =
            false;

        stopwatchCategory.value =
            "";

    }


    if (stopwatchStartButton) {

        stopwatchStartButton.textContent =
            "시작";

    }


    updateStopwatchDisplay();



if (stopwatchCategory) {

    stopwatchCategory.addEventListener(
        "change",
        function () {

            if (
                stopwatchRunning
            ) {
                return;
            }


            stopwatchCurrentCategory =
                stopwatchCategory.value;

            updateStopwatchCategoryColor();


            stopwatchSeconds =
                0;


            updateStopwatchDisplay();

        }
    );

}


if (stopwatchStartButton) {

    stopwatchStartButton.addEventListener(
        "click",
        startStopwatch
    );

}


if (stopwatchResetButton) {

    stopwatchResetButton.addEventListener(
        "click",
        resetStopwatch
    );

}


// ============================================================
// 32. 공부 기록 표시
// ============================================================

function showStudyRecords() {

    if (!studyRecordList) {
        return;
    }


    clearElement(
        studyRecordList
    );


    const todayString =
        getTodayString();


    const totals = {};


    studyRecords.forEach(
        function (record) {

            if (
                record.date !==
                todayString
            ) {
                return;
            }


            if (
                !record.category
            ) {
                return;
            }


            totals[record.category] =
                (
                    totals[record.category] ||
                    0
                ) +
                (
                    Number(
                        record.seconds
                    ) || 0
                );

        }
    );


    categories.forEach(
        function (category) {

            const seconds =
                totals[category.name] ||
                0;


            const item =
                createElement(
                    "div",
                    "study-record-item"
                );

            const colorDot =
                createElement(
                    "span",
                    "study-record-color"
                );

            colorDot.style.backgroundColor =
                category.color ||
                getDefaultCategoryColor(categories.indexOf(category));

            const text =
                createElement(
                    "span",
                    "",
                    `${category.name} · ${formatStudyTime(seconds)}`
                );

            item.appendChild(colorDot);
            item.appendChild(text);

            studyRecordList.appendChild(
                item
            );

        }
    );
}


// ============================================================
// 33. 공부 통계
// ============================================================

function getCategoryStudyRange(period) {

    const now = new Date();


    if (period === "day") {

        const today =
            getTodayString();

        return {
            startDate: today,
            endDate: today
        };

    }


    if (period === "week") {

        const monday =
            getMonday(now);

        const sunday =
            new Date(monday);

        sunday.setDate(
            monday.getDate() + 6
        );

        return {
            startDate: getDateString(monday),
            endDate: getDateString(sunday)
        };

    }


    // 1달 = 현재 달
    const firstDay =
        new Date(
            now.getFullYear(),
            now.getMonth(),
            1
        );

    const lastDay =
        new Date(
            now.getFullYear(),
            now.getMonth() + 1,
            0
        );

    return {
        startDate: getDateString(firstDay),
        endDate: getDateString(lastDay)
    };

}


function getCategoryStudyTotals(period) {

    const range =
        getCategoryStudyRange(period);

    const totals = {};


    studyRecords.forEach(
        function (record) {

            if (
                !record.category ||
                record.date < range.startDate ||
                record.date > range.endDate
            ) {
                return;
            }


            totals[record.category] =
                (
                    totals[record.category] ||
                    0
                ) +
                (
                    Number(
                        record.seconds
                    ) || 0
                );

        }
    );


    return totals;
}


function updateCategoryStudyPeriodButtons() {

    statsPeriodButtons.forEach(
        function (button) {

            button.classList.toggle(
                "active",
                button.dataset.period ===
                categoryStudyPeriod
            );

        }
    );

}


function showStudyStats() {

    const today =
        getTodayString();


    const monday =
        getMonday(
            new Date()
        );


    const mondayString =
        getDateString(
            monday
        );


    const sunday =
        new Date(
            monday
        );


    sunday.setDate(
        monday.getDate() + 6
    );


    const sundayString =
        getDateString(
            sunday
        );


    const todaySeconds =
        getStudySecondsForDate(
            today
        );


    const weekSeconds =
        getStudySecondsForRange(
            mondayString,
            sundayString
        );


    if (todayStudyTime) {

        todayStudyTime.textContent =
            formatStudyTime(
                todaySeconds
            );

    }


    if (weekStudyTime) {

        weekStudyTime.textContent =
            formatStudyTime(
                weekSeconds
            );

    }


    // --------------------
    // 카테고리별
    // --------------------

    const totals =
        getCategoryStudyTotals(
            categoryStudyPeriod
        );


    updateCategoryStudyPeriodButtons();


    if (categoryStudyStats) {

        clearElement(
            categoryStudyStats
        );


        categories.forEach(
            function (category) {

                const seconds =
                    totals[category.name] ||
                    0;


                const item =
                    createElement(
                        "div",
                        "stats-category-item"
                    );

                const colorDot =
                    createElement(
                        "span",
                        "stats-color-dot"
                    );

                colorDot.style.backgroundColor =
                    category.color ||
                    getDefaultCategoryColor(
                        categories.indexOf(category)
                    );

                const text =
                    createElement(
                        "span",
                        "",
                        `${category.name} · ${formatStudyTime(seconds)}`
                    );

                item.appendChild(colorDot);
                item.appendChild(text);

                categoryStudyStats.appendChild(item);

            }
        );

    }


    // --------------------
    // 비율 + 도넛
    // --------------------

    const donut =
        getElement("categoryStudyDonut");

    if (categoryStudyRatio) {
        clearElement(categoryStudyRatio);
    }

    if (donut) {
        donut.style.background = "#eee";
    }


    const totalSeconds =
        Object.values(totals).reduce(
            function (sum, seconds) {
                return sum + seconds;
            },
            0
        );


    const categoryRatios =
        categories.map(
            function (category) {

                const seconds =
                    totals[category.name] ||
                    0;

                return {
                    category: category,
                    seconds: seconds,
                    ratio: totalSeconds === 0
                        ? 0
                        : (seconds / totalSeconds) * 100
                };

            }
        );


    if (totalSeconds === 0) {

        if (categoryStudyRatio) {

            categoryStudyRatio.appendChild(
                createElement(
                    "div",
                    "",
                    "공부 기록이 없습니다."
                )
            );

        }

    }

    else {

        if (categoryStudyRatio) {

            categoryRatios.forEach(
                function (data) {

                    const ratio =
                        Math.round(
                            data.ratio
                        );

                    const item =
                        createElement(
                            "div",
                            "statistics-ratio-item"
                        );

                    const dot =
                        createElement(
                            "span",
                            "stats-color-dot"
                        );

                    dot.style.backgroundColor =
                        data.category.color ||
                        getDefaultCategoryColor(
                            categories.indexOf(
                                data.category
                            )
                        );

                    const text =
                        createElement(
                            "span",
                            "",
                            `${data.category.name} · ${ratio}%`
                        );

                    item.appendChild(dot);
                    item.appendChild(text);
                    categoryStudyRatio.appendChild(item);

                }
            );

        }


        if (donut) {

            const stops = [];
            let accumulated = 0;


            categoryRatios.forEach(
                function (data) {

                    if (
                        data.ratio <= 0
                    ) {
                        return;
                    }


                    const color =
                        data.category.color ||
                        getDefaultCategoryColor(
                            categories.indexOf(
                                data.category
                            )
                        );


                    const start =
                        accumulated;

                    accumulated +=
                        data.ratio;


                    stops.push(
                        `${color} ${start}% ${accumulated}%`
                    );

                }
            );


            donut.style.background =
                `conic-gradient(${stops.join(", ")})`;

        }

    }


    showDailyStudyGoal();
}


// 카테고리별 기간 선택
statsPeriodButtons.forEach(
    function (button) {

        button.addEventListener(
            "click",
            function () {

                const period =
                    button.dataset.period;


                if (
                    ![
                        "day",
                        "week",
                        "month"
                    ].includes(period)
                ) {
                    return;
                }


                categoryStudyPeriod =
                    period;

                showStudyStats();

            }
        );

    }
);


// ============================================================
// 34. 하루 공부 목표
// ============================================================

function showDailyStudyGoal() {

    if (
        !dailyStudyGoalElement
    ) {
        return;
    }


    dailyStudyGoalElement.textContent =
        formatStudyTime(
            dailyStudyGoal
        );
}


if (setStudyGoalButton) {

    setStudyGoalButton.addEventListener(
        "click",
        function () {

            const input =
                prompt(
                    "하루 공부 목표 시간을 분 단위로 입력하세요.",
                    Math.floor(
                        dailyStudyGoal / 60
                    )
                );


            if (
                input === null
            ) {
                return;
            }


            const minutes =
                Number(input);


            if (
                !Number.isFinite(minutes) ||
                minutes <= 0
            ) {

                alert(
                    "1분 이상의 숫자를 입력하세요."
                );

                return;
            }


            dailyStudyGoal =
                Math.floor(
                    minutes * 60
                );


            localStorage.setItem(
                "dailyStudyGoal",
                String(
                    dailyStudyGoal
                )
            );

            saveCloudData(
                "dailyStudyGoal",
                dailyStudyGoal
            );


            showDailyStudyGoal();

        }
    );

}


// ============================================================
// 35. 최근 7일 그래프
// ============================================================

function showWeeklyStudyChart() {

    if (!weeklyStudyChart) {
        return;
    }


    clearElement(
        weeklyStudyChart
    );


    const monday =
        getMonday(
            new Date()
        );


    const weekdayNames = [
        "월",
        "화",
        "수",
        "목",
        "금",
        "토",
        "일"
    ];


    const dailySeconds = [];


    for (
        let i = 0;
        i < 7;
        i++
    ) {

        const date =
            new Date(monday);


        date.setDate(
            monday.getDate() + i
        );


        dailySeconds.push(
            getStudySecondsForDate(
                getDateString(date)
            )
        );

    }


    const maxSeconds =
        Math.max(
            ...dailySeconds,
            1
        );


    const todayDay =
        new Date().getDay();


    const todayIndex =
        todayDay === 0
            ? 6
            : todayDay - 1;


    dailySeconds.forEach(
        function (
            seconds,
            index
        ) {

            const bar =
                createElement(
                    "div",
                    "weekly-study-bar"
                );


            if (
                index ===
                todayIndex
            ) {

                bar.classList.add(
                    "today"
                );

            }


            const value =
                createElement(
                    "div",
                    "weekly-study-bar-value",
                    formatStudyTime(seconds)
                );


            const fill =
                createElement(
                    "div",
                    "weekly-study-bar-fill"
                );


            const height =
                seconds === 0
                    ? 2
                    : seconds /
                    maxSeconds *
                    160;


            fill.style.height =
                `${height}px`;


            const labelText =
                index ===
                    todayIndex
                    ? `${weekdayNames[index]} (오늘)`
                    : weekdayNames[index];


            const label =
                createElement(
                    "div",
                    "weekly-study-bar-label",
                    labelText
                );


            bar.appendChild(value);
            bar.appendChild(fill);
            bar.appendChild(label);


            weeklyStudyChart.appendChild(
                bar
            );

        }
    );
}


// ============================================================
// 36. 화면 전환
// ============================================================

const todoTab =
    getElement("todoTab");

const memoTab =
    getElement("memoTab");

const scheduleTab =
    getElement("scheduleTab");

const ddayTab =
    getElement("ddayTab");

const projectTab =
    getElement("projectTab");

const stopwatchTab =
    getElement("stopwatchTab");

const statsTab =
    getElement("statsTab");


const todoSection =
    getElement("todoSection");

const memoSection =
    getElement("memoSection");

const scheduleSection =
    getElement("scheduleSection");

const ddaySection =
    getElement("ddaySection");

const projectSection =
    getElement("projectSection");

const stopwatchSection =
    getElement("stopwatchSection");

const statsSection =
    getElement("statsSection");


const sections = [

    todoSection,
    memoSection,
    scheduleSection,
    ddaySection,
    projectSection,
    stopwatchSection,
    statsSection

].filter(Boolean);


// ====================
// 화면 표시
// ====================

function showSection(
    section,
    selectedButton
) {

    sections.forEach(
        function (currentSection) {

            currentSection.style.display =
                "none";

        }
    );


    section.style.display =
        "block";


    document
        .querySelectorAll(
            ".feature-button"
        )
        .forEach(
            function (button) {

                button.classList.remove(
                    "active"
                );

            }
        );


    selectedButton.classList.add(
        "active"
    );

}


// ============================================================
// 37. 탭 이벤트
// ============================================================

const TAB_ACTIONS = [
    [todoTab, todoSection, () => showTodos()],
    [memoTab, memoSection, () => showMemos()],
    [scheduleTab, scheduleSection, () => {
        showSchedules();
        createClockNumbers();
        createClockTicks();
        updateScheduleClock();
    }],
    [ddayTab, ddaySection, () => showDDays()],
    [projectTab, projectSection, () => showProjects()],
    [stopwatchTab, stopwatchSection, () => {
        loadStopwatchCategories();
        showStudyRecords();
    }],
    [statsTab, statsSection, () => {
        showStudyStats();
        showWeeklyStudyChart();
    }]
];

TAB_ACTIONS.forEach(([tab, section, render]) => {
    if (!tab || !section) return;
    tab.addEventListener("click", (event) => {
        // 집중 모드에서는 수동 정지/초기화 전까지 다른 기능 화면으로 이동하지 않는다.
        if (
            tab !== stopwatchTab &&
            isStopwatchFocusActive()
        ) {
            event.preventDefault();
            event.stopPropagation();

            alert(
                stopwatchAutoPaused
                    ? "스톱워치가 일시정지되어 있습니다. 스톱워치에서 [재개] 또는 [정지]를 눌러주세요."
                    : "스톱워치 집중 모드입니다. 공부를 끝내려면 스톱워치에서 [정지]를 눌러주세요."
            );

            if (stopwatchTab && stopwatchSection) {
                showSection(stopwatchSection, stopwatchTab);
            }
            return;
        }

        showSection(section, tab);
        render();
    });
});


// ============================================================
// 38. 디지털 시계
// ============================================================

const digitalClock =
    getElement("clock");


function updateClock() {

    if (!digitalClock) {
        return;
    }


    const now =
        new Date();


    digitalClock.textContent =
        `${pad(now.getHours())}:` +
        `${pad(now.getMinutes())}:` +
        `${pad(now.getSeconds())}`;
}


updateClock();


setInterval(
    updateClock,
    1000
);

// ============================================================
// 모바일 / iPad 터치 정렬
// ============================================================

function enableTouchReorder(listElement, cardSelector, saveOrder) {
    if (!listElement) return;

    let touchCard = null;
    let placeholder = null;
    let preview = null;
    let dragging = false;

    function removePreview() {
        if (preview) {
            preview.remove();
            preview = null;
        }
    }

    function cleanup() {
        removePreview();

        if (placeholder) {
            placeholder.remove();
            placeholder = null;
        }

        if (touchCard) {
            touchCard.style.display = "";
            touchCard.classList.remove("touch-dragging");
        }

        touchCard = null;
        dragging = false;
    }

    function createPreview(touch) {
        const rect = touchCard.getBoundingClientRect();

        preview = touchCard.cloneNode(true);
        preview.classList.remove("touch-dragging", "dragging");
        preview.classList.add("touch-drag-preview");

        preview.style.width = `${rect.width}px`;
        preview.style.height = `${rect.height}px`;
        preview.style.left = `${touch.clientX - rect.width / 2}px`;
        preview.style.top = `${touch.clientY - 28}px`;

        document.body.appendChild(preview);
    }

    function createPlaceholder() {
        const rect = touchCard.getBoundingClientRect();

        placeholder = document.createElement("div");
        placeholder.className = "touch-drag-placeholder";
        placeholder.style.width = `${rect.width}px`;
        placeholder.style.height = `${rect.height}px`;

        touchCard.style.display = "none";

        listElement.insertBefore(
            placeholder,
            touchCard
        );
    }

    function getClosestCard(x, y) {
        const cards = Array.from(
            listElement.querySelectorAll(cardSelector)
        ).filter(function (card) {
            return (
                card !== touchCard &&
                card !== placeholder &&
                card.style.display !== "none"
            );
        });

        let closest = null;
        let closestDistance = Infinity;

        cards.forEach(function (card) {
            const rect = card.getBoundingClientRect();

            const centerX = rect.left + rect.width / 2;
            const centerY = rect.top + rect.height / 2;

            const dx = x - centerX;
            const dy = y - centerY;
            const distance = dx * dx + dy * dy;

            if (distance < closestDistance) {
                closestDistance = distance;
                closest = card;
            }
        });

        return closest;
    }

    function updatePlaceholder(x, y) {
        const targetCard = getClosestCard(x, y);

        if (!targetCard) return;

        const rect = targetCard.getBoundingClientRect();
        const centerX = rect.left + rect.width / 2;
        const centerY = rect.top + rect.height / 2;

        let insertBefore;

        /*
         * 세로 목록에서는 Y축,
         * 메모처럼 가로/그리드에서는 X축을 우선 사용한다.
         */
        const verticalDistance = Math.abs(y - centerY);
        const horizontalDistance = Math.abs(x - centerX);

        if (verticalDistance > horizontalDistance) {
            insertBefore = y < centerY;
        } else {
            insertBefore = x < centerX;
        }

        if (insertBefore) {
            if (placeholder.nextElementSibling !== targetCard) {
                listElement.insertBefore(placeholder, targetCard);
            }
        } else {
            if (targetCard.nextElementSibling !== placeholder) {
                listElement.insertBefore(
                    placeholder,
                    targetCard.nextSibling
                );
            }
        }
    }

    listElement.addEventListener(
        "touchstart",
        function (event) {
            if (touchCard) return;

            const handle = event.target.closest(
                ".memo-drag-handle, .dday-drag-handle, .project-drag-handle"
            );

            if (!handle) return;

            touchCard = handle.closest(cardSelector);

            if (!touchCard) return;

            const touch = event.touches[0];

            dragging = true;
            touchCard.classList.add("touch-dragging");

            createPlaceholder();
            createPreview(touch);
        },
        { passive: true }
    );

    listElement.addEventListener(
        "touchmove",
        function (event) {
            if (!touchCard || !dragging) return;

            event.preventDefault();

            const touch = event.touches[0];

            if (preview) {
                preview.style.left =
                    `${touch.clientX - preview.offsetWidth / 2}px`;
                preview.style.top =
                    `${touch.clientY - 28}px`;
            }

            updatePlaceholder(
                touch.clientX,
                touch.clientY
            );
        },
        { passive: false }
    );

    listElement.addEventListener(
        "touchend",
        function () {
            if (!touchCard) return;

            removePreview();

            if (placeholder) {
                listElement.insertBefore(
                    touchCard,
                    placeholder
                );

                placeholder.remove();
                placeholder = null;
            }

            touchCard.style.display = "";
            touchCard.classList.remove("touch-dragging");

            saveOrder();

            touchCard = null;
            dragging = false;
        }
    );

    listElement.addEventListener(
        "touchcancel",
        function () {
            if (!touchCard) return;
            cleanup();
        }
    );
}


// Memo
enableTouchReorder(
    memoList,
    ".memo-card",
    saveMemoOrder
);


// D-Day
enableTouchReorder(
    ddayList,
    ".dday-card",
    function () {
        const cards = Array.from(
            ddayList.querySelectorAll(".dday-card")
        );

        const newDDays = [];

        cards.forEach(function (card) {
            if (card._dday) {
                newDDays.push(card._dday);
                return;
            }

            const titleElement = card.querySelector("h3");
            if (!titleElement) return;

            const found = dDays.find(function (item) {
                return item.title === titleElement.textContent;
            });

            if (found) newDDays.push(found);
        });

        if (newDDays.length === dDays.length) {
            dDays = newDDays;
            saveDDays();
        }
    }
);


// Project
enableTouchReorder(
    projectList,
    ".project-item",
    saveProjectOrder
);

// ============================================================
// 39. 초기화
// ============================================================

normalizeData();


// 일정 Todo UI 생성
createScheduleTodoSelector();


// Todo
updateTodoFilterButtons();


// 달력
renderCalendar();


// Todo
showTodos();


// 메모
showMemos();


// 일정
showSchedules();


// D-Day
showDDays();


// 프로젝트
showProjects();


// 스톱워치
loadStopwatchCategories();

updateStopwatchDisplay();

showStudyRecords();


// 통계
showStudyStats();

showWeeklyStudyChart();


// 하루 목표
showDailyStudyGoal();


// Todo 알림
initTodoAlarmUI();

initTodoForegroundMessaging();


// 24시간 시계
createClockNumbers();

createClockTicks();

updateScheduleClock();


setInterval(
    updateScheduleClock,
    1000
);


// ============================================================
// END
// ============================================================
