importScripts("https://www.gstatic.com/firebasejs/12.8.0/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/12.8.0/firebase-messaging-compat.js");

firebase.initializeApp({
  apiKey: "AIzaSyBF-wTk14lNmZlOKuwrwjZLN3vpVZPyAyM",
  authDomain: "my-dashboard-2b50f.firebaseapp.com",
  projectId: "my-dashboard-2b50f",
  storageBucket: "my-dashboard-2b50f.firebasestorage.app",
  messagingSenderId: "966095927988",
  appId: "1:966095927988:web:14f81692ddb4255f1835e1"
});

const messaging = firebase.messaging();

messaging.onBackgroundMessage(function (payload) {
  const notification =
    payload && payload.notification
      ? payload.notification
      : {};

  const data =
    payload && payload.data
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

  self.registration.showNotification(title, {
    body: body,
    icon: "/icon-192.png",
    badge: "/icon-192.png",
    tag: data.tag || "todo-alarm",
    renotify: true,
    data: {
      url: data.url || "/"
    }
  });
});

self.addEventListener("notificationclick", function (event) {
  event.notification.close();

  const targetUrl =
    event.notification &&
    event.notification.data &&
    event.notification.data.url
      ? event.notification.data.url
      : "/";

  event.waitUntil(
    clients.matchAll({
      type: "window",
      includeUncontrolled: true
    }).then(function (clientList) {
      for (const client of clientList) {
        if ("focus" in client) {
          client.navigate(targetUrl);
          return client.focus();
        }
      }

      if (clients.openWindow) {
        return clients.openWindow(targetUrl);
      }

      return undefined;
    })
  );
});