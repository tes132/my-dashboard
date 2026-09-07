const { onSchedule } = require("firebase-functions/v2/scheduler");
const {
    initializeApp,
    getApp
} = require("firebase-admin/app");
const {
    getFirestore,
    FieldValue
} = require("firebase-admin/firestore");
const {
    getMessaging
} = require("firebase-admin/messaging");

initializeApp();

const db = getFirestore();
const messaging = getMessaging();

const CLOUD_DATA_COLLECTION = "data";
const ALARM_SETTINGS_DOC = "todoAlarmSettings";
const CATEGORIES_DOC = "categories";
const TOKENS_COLLECTION = "pushTokens";

// ------------------------------------------------------------
// 시간대별 현재 날짜/시간
// ------------------------------------------------------------
function getTimePartsForZone(date, timeZone) {
    const formatter = new Intl.DateTimeFormat("en-CA", {
        timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23"
    });

    const parts = formatter.formatToParts(date);
    const map = {};

    for (const part of parts) {
        if (part.type !== "literal") {
            map[part.type] = part.value;
        }
    }

    return {
        date: `${map.year}-${map.month}-${map.day}`,
        time: `${map.hour}:${map.minute}`
    };
}

// ------------------------------------------------------------
// Todo가 해당 날짜에 나타나는지 확인
// ------------------------------------------------------------
function todoAppearsOnDate(todo, targetDate) {
    const repeat = todo.repeat || "none";

    // 반복 없음
    if (repeat === "none") {
        return todo.date === targetDate;
    }

    // 시작일 이전
    if (targetDate < todo.date) {
        return false;
    }

    // 매일
    if (repeat === "daily") {
        return true;
    }

    // 매주
    if (repeat === "weekly") {
        const startDate = new Date(`${todo.date}T00:00:00`);
        const targetDateObject = new Date(`${targetDate}T00:00:00`);

        return (
            startDate.getDay() ===
            targetDateObject.getDay()
        );
    }

    return false;
}

// ------------------------------------------------------------
// Todo의 해당 날짜 완료 여부
// ------------------------------------------------------------
function isTodoCompletedOnDate(todo, dateString) {
    const repeat = todo.repeat || "none";

    if (repeat !== "none") {
        return (
            Array.isArray(todo.completedDates) &&
            todo.completedDates.includes(dateString)
        );
    }

    return todo.completed === true;
}

// ------------------------------------------------------------
// 오늘 남은 Todo 개수
// ------------------------------------------------------------
function getRemainingTodoCount(categories, dateString) {
    let count = 0;

    if (!Array.isArray(categories)) {
        return count;
    }

    for (const category of categories) {
        if (!category || !Array.isArray(category.todos)) {
            continue;
        }

        for (const todo of category.todos) {
            if (
                todoAppearsOnDate(todo, dateString) &&
                !isTodoCompletedOnDate(todo, dateString)
            ) {
                count++;
            }
        }
    }

    return count;
}

// ------------------------------------------------------------
// 알람 설정 정리
// ------------------------------------------------------------
function getAlarmSettings(raw) {
    if (!raw || typeof raw !== "object") {
        return {
            enabled: false,
            times: [],
            timeZone: "Asia/Seoul"
        };
    }

    const times = Array.isArray(raw.times)
        ? raw.times
            .filter((time) => /^\d{2}:\d{2}$/.test(time))
            .filter(
                (time, index, array) =>
                    array.indexOf(time) === index
            )
        : [];

    return {
        enabled: raw.enabled === true,
        times,
        timeZone:
            typeof raw.timeZone === "string" &&
                raw.timeZone
                ? raw.timeZone
                : "Asia/Seoul"
    };
}

// ------------------------------------------------------------
// 중복 발송 방지
//
// 같은 알람이 두 번 실행되어도
// 같은 사용자/시간에 중복 발송되지 않게 한다.
// ------------------------------------------------------------
async function claimDelivery(userRef, deliveryKey) {
    const deliveryRef = userRef
        .collection("alarmDeliveries")
        .doc(deliveryKey);

    try {
        await db.runTransaction(async (transaction) => {
            const snapshot = await transaction.get(deliveryRef);

            if (snapshot.exists) {
                throw new Error("ALREADY_DELIVERED");
            }

            transaction.create(deliveryRef, {
                createdAt: FieldValue.serverTimestamp()
            });
        });

        return true;
    } catch (error) {
        if (
            error &&
            error.message === "ALREADY_DELIVERED"
        ) {
            return false;
        }

        throw error;
    }
}

// ------------------------------------------------------------
// 죽은 FCM 토큰 정리
// ------------------------------------------------------------
async function cleanupToken(tokenDocRef) {
    try {
        await tokenDocRef.delete();
    } catch (error) {
        console.warn(
            "푸시 토큰 삭제 실패:",
            error
        );
    }
}

// ------------------------------------------------------------
// FCM 오류 처리
// ------------------------------------------------------------
async function handleMessagingError(
    error,
    userId,
    tokenDocRef
) {
    console.warn(
        `FCM 전송 실패 (${userId}):`,
        error
    );

    const errorCode =
        error && error.code
            ? error.code
            : "";

    if (
        errorCode.includes(
            "registration-token-not-registered"
        ) ||
        errorCode.includes(
            "invalid-registration-token"
        )
    ) {
        await cleanupToken(tokenDocRef);
    }
}

// ------------------------------------------------------------
// 후보 시간 생성
//
// Cloud Scheduler가 몇 초~1분 정도 늦게 실행될 수 있으므로
// 현재 분 + 직전 2분까지 검사한다.
//
// 예:
// 알람 = 09:00
// 함수 실행 = 09:01
// → 09:00 알람을 놓치지 않음
// ------------------------------------------------------------
function getCandidateTimes(now, timeZone) {
    const candidates = [];

    for (let offset = 0; offset <= 2; offset++) {
        const candidateDate = new Date(
            now.getTime() -
            offset * 60 * 1000
        );

        candidates.push(
            getTimePartsForZone(
                candidateDate,
                timeZone
            )
        );
    }

    return candidates;
}

// ------------------------------------------------------------
// FCM 발송
// ------------------------------------------------------------
async function sendNotificationToTokens(
    tokenSnapshot,
    title,
    body,
    tag,
    url
) {
    for (const tokenDoc of tokenSnapshot.docs) {
        const tokenData =
            tokenDoc.data() || {};

        const token = tokenData.token;

        if (!token) {
            await cleanupToken(tokenDoc.ref);
            continue;
        }

        try {
            await messaging.send({
                token,
                data: {
                    title: String(title),
                    body: String(body),
                    tag: String(tag),
                    url: String(url)
                }
            });

            console.log(
                "FCM 전송 성공:",
                tokenDoc.id
            );
        } catch (error) {
            await handleMessagingError(
                error,
                tokenDoc.ref.parent.parent.id,
                tokenDoc.ref
            );
        }
    }
}

// ============================================================
// Todo 알람
// ============================================================

exports.sendTodoAlarms = onSchedule(
    {
        // 매분 실행
        schedule: "* * * * *",

        // Scheduler 자체는 UTC로 동작시킨다.
        // 실제 사용자 시간은 아래에서 timeZone으로 계산한다.
        timeZone: "UTC",

        region: "asia-northeast3",

        memory: "256MiB"
    },

    async () => {
        const now = new Date();

        console.log(
            "================================================"
        );
        console.log(
            "=== Todo Alarm 실행 ==="
        );
        console.log(
            "현재 UTC:",
            now.toISOString()
        );

        // ----------------------------------------------------
        // 모든 사용자 확인
        // ----------------------------------------------------
        const userSnapshot =
            await db.collection("users").get();

        // ============================================================
        // Firestore 연결 최종 진단
        // ============================================================

        console.log(
            "Admin SDK 프로젝트 ID:",
            getApp().options.projectId
        );

        console.log(
            "Firestore 데이터베이스 ID:",
            db._settings.databaseId
        );

        // 최상위 컬렉션
        const topLevelCollections =
            await db.listCollections();

        console.log(
            "서버가 보는 최상위 컬렉션:",
            topLevelCollections.map(
                (collection) => collection.id
            )
        );

        // users 컬렉션 직접 조회
        const usersSnapshot =
            await db.collection("users").get();

        console.log(
            "users 문서 수:",
            usersSnapshot.size
        );

        console.log(
            "users 문서 ID:",
            usersSnapshot.docs.map(
                (doc) => doc.id
            )
        );

        // 테스트 사용자 직접 조회
        const testUserId =
            "kbEWsxTZ36aBoMeHuilfBydpqxb2";

        const testUserSnapshot =
            await db
                .collection("users")
                .doc(testUserId)
                .get();

        console.log(
            "테스트 사용자 ID:",
            testUserId
        );

        console.log(
            "테스트 사용자 문서 존재:",
            testUserSnapshot.exists
        );
        
        // ----------------------------------------------------
        // 사용자 하나씩 처리
        // ----------------------------------------------------
        for (
            const userDoc of
            usersSnapshot.docs
        ) {
            const userRef =
                userDoc.ref;

            try {
                // --------------------------------------------
                // 알람 설정 + Todo + 토큰 읽기
                // --------------------------------------------
                const [
                    settingsSnapshot,
                    categoriesSnapshot,
                    tokenSnapshot
                ] = await Promise.all([
                    userRef
                        .collection(
                            CLOUD_DATA_COLLECTION
                        )
                        .doc(
                            ALARM_SETTINGS_DOC
                        )
                        .get(),

                    userRef
                        .collection(
                            CLOUD_DATA_COLLECTION
                        )
                        .doc(
                            CATEGORIES_DOC
                        )
                        .get(),

                    userRef
                        .collection(
                            TOKENS_COLLECTION
                        )
                        .get()
                ]);

                // 알람 설정 또는 토큰이 없으면 건너뜀
                if (
                    !settingsSnapshot.exists ||
                    !tokenSnapshot.size
                ) {
                    continue;
                }

                // --------------------------------------------
                // 알람 설정
                // --------------------------------------------
                const settings =
                    getAlarmSettings(
                        settingsSnapshot
                            .data()
                            .value
                    );

                if (
                    !settings.enabled ||
                    settings.times.length === 0
                ) {
                    continue;
                }

                // --------------------------------------------
                // 해당 사용자의 시간대 기준으로
                // 현재 분 + 직전 2분 계산
                // --------------------------------------------
                let candidateTimes;

                try {
                    candidateTimes =
                        getCandidateTimes(
                            now,
                            settings.timeZone
                        );
                } catch (timezoneError) {
                    console.warn(
                        `잘못된 timeZone (${userDoc.id}):`,
                        settings.timeZone,
                        timezoneError
                    );

                    continue;
                }

                // --------------------------------------------
                // categories
                // --------------------------------------------
                const categoriesValue =
                    categoriesSnapshot.exists
                        ? categoriesSnapshot
                            .data()
                            .value
                        : [];

                // ==================================================
                // 1. 설정한 시간의 "오늘 남은 Todo" 알림
                // ==================================================
                for (
                    const local of candidateTimes
                ) {
                    if (
                        !settings.times.includes(
                            local.time
                        )
                    ) {
                        continue;
                    }

                    console.log(
                        "알람 시간 일치:",
                        userDoc.id,
                        local.date,
                        local.time
                    );

                    const remainingCount =
                        getRemainingTodoCount(
                            categoriesValue,
                            local.date
                        );

                    // 남은 Todo가 없으면 알림도 보내지 않음
                    if (
                        remainingCount <= 0
                    ) {
                        console.log(
                            "남은 Todo 없음:",
                            userDoc.id,
                            local.date
                        );

                        continue;
                    }

                    // 사용자 + 날짜 + 시간 기준
                    // 한 번만 발송
                    const deliveryKey =
                        `${local.date}_${local.time}`;

                    const claimed =
                        await claimDelivery(
                            userRef,
                            deliveryKey
                        );

                    if (!claimed) {
                        continue;
                    }

                    const title =
                        "📋 오늘 할 일";

                    const body =
                        `오늘 할 일이 ${remainingCount}개 남아 있어요.`;

                    await sendNotificationToTokens(
                        tokenSnapshot,
                        title,
                        body,
                        `todo-alarm-${deliveryKey}`,
                        "/"
                    );
                }

                // ==================================================
                // 2. 개별 Todo 마감 시간 알림
                // ==================================================
                if (
                    !Array.isArray(
                        categoriesValue
                    )
                ) {
                    continue;
                }

                for (
                    const category of
                    categoriesValue
                ) {
                    if (
                        !category ||
                        !Array.isArray(
                            category.todos
                        )
                    ) {
                        continue;
                    }

                    for (
                        const todo of
                        category.todos
                    ) {
                        if (
                            !todo ||
                            !todo.deadline
                        ) {
                            continue;
                        }

                        // 후보 시간 3개 확인
                        for (
                            const local of
                            candidateTimes
                        ) {
                            // Todo가 해당 날짜에 표시되는지
                            if (
                                !todoAppearsOnDate(
                                    todo,
                                    local.date
                                )
                            ) {
                                continue;
                            }

                            // 해당 날짜에 이미 완료했는지
                            if (
                                isTodoCompletedOnDate(
                                    todo,
                                    local.date
                                )
                            ) {
                                continue;
                            }

                            // Todo 마감 시간과
                            // 후보 시간이 같은지
                            if (
                                todo.deadline !==
                                local.time
                            ) {
                                continue;
                            }

                            // Todo 고유 ID가 있으면 사용
                            // 없으면 기존 데이터 구조를 이용해서 생성
                            const todoId =
                                todo.id ||
                                `${category.name || "category"}_${todo.text || "todo"}`;

                            // 사용자 + 날짜 + Todo + 시간
                            const deliveryKey =
                                `${local.date}_todo_${todoId}_${local.time}`;

                            const claimed =
                                await claimDelivery(
                                    userRef,
                                    deliveryKey
                                );

                            if (!claimed) {
                                continue;
                            }

                            const title =
                                "⏰ Todo 알림";

                            const body =
                                `${todo.text || "할 일"} 할 시간이에요.`;

                            await sendNotificationToTokens(
                                tokenSnapshot,
                                title,
                                body,
                                `todo-deadline-${deliveryKey}`,
                                "/"
                            );
                        }
                    }
                }
            } catch (error) {
                console.error(
                    `사용자 알람 처리 실패 (${userDoc.id}):`,
                    error
                );
            }
        }

        console.log(
            "=== Todo Alarm 종료 ==="
        );
    }
);