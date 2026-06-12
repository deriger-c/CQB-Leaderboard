(function () {
  "use strict";

  var config = window.CQB_CONFIG || {};
  var defaultStorageKey = "cqb-room-device-token";
  var deviceTokenKey = config.LOCAL_STORAGE_DEVICE_TOKEN_KEY || defaultStorageKey;
  var apiBaseUrl = (config.API_BASE_URL || "").trim();

  var state = {
    entries: [],
    isLoading: false,
    isAdmin: Boolean(readDeviceToken()),
    isAdminEntryOpen: Boolean(readDeviceToken()),
    apiConfigured: isApiConfigured(apiBaseUrl),
    activePeriod: "all",
    lastSubmittedResult: null,
    highlightedPlayerKey: null,
    isSavingResult: false,
    lastUpdatedAt: null
  };

  var highlightTimer = null;
  var autoRefreshTimer = null;
  var autoRefreshIntervalMs = 30000;

  var elements = {
    statusBanner: document.getElementById("statusBanner"),
    refreshButton: document.getElementById("refreshButton"),
    adminToggleButton: document.getElementById("adminToggleButton"),
    logoutButton: document.getElementById("logoutButton"),
    leaderboardBody: document.getElementById("leaderboardBody"),
    leaderboardEmpty: document.getElementById("leaderboardEmpty"),
    recentList: document.getElementById("recentList"),
    recentEmpty: document.getElementById("recentEmpty"),
    playersCount: document.getElementById("playersCount"),
    attemptsCount: document.getElementById("attemptsCount"),
    bestTimeValue: document.getElementById("bestTimeValue"),
    lastUpdated: document.getElementById("lastUpdated"),
    periodControl: document.getElementById("periodControl"),
    adminPanel: document.getElementById("adminPanel"),
    authBox: document.getElementById("authBox"),
    adminBox: document.getElementById("adminBox"),
    loginForm: document.getElementById("loginForm"),
    resultForm: document.getElementById("resultForm"),
    passwordInput: document.getElementById("passwordInput"),
    playerNameInput: document.getElementById("playerNameInput"),
    timeInput: document.getElementById("timeInput")
  };

  bindEvents();
  renderPeriodControls();
  syncAuthUi();
  renderAll();

  if (state.apiConfigured) {
    loadEntries();
    startAutoRefresh();
  } else {
    renderLastUpdated();
  }

  function bindEvents() {
    elements.refreshButton.addEventListener("click", function () {
      if (state.apiConfigured) {
        loadEntries(true);
      }
    });

    elements.adminToggleButton.addEventListener("click", function () {
      if (state.isAdmin) {
        elements.playerNameInput.focus();
        return;
      }

      state.isAdminEntryOpen = !state.isAdminEntryOpen;
      syncAdminPanelUi();

      if (!state.isAdminEntryOpen) {
        return;
      }

      elements.passwordInput.focus();
      window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" });
    });

    elements.logoutButton.addEventListener("click", function () {
      localStorage.removeItem(deviceTokenKey);
      state.isAdmin = false;
      state.isAdminEntryOpen = false;
      syncAuthUi();
      showStatus("המכשיר הזה כבר לא נחשב מהימן.", false);
    });

    elements.loginForm.addEventListener("submit", handleLoginSubmit);
    elements.resultForm.addEventListener("submit", handleResultSubmit);
    elements.recentList.addEventListener("click", handleRecentListClick);

    if (elements.periodControl) {
      elements.periodControl.addEventListener("click", function (event) {
        var button = event.target.closest("[data-period]");

        if (!button) {
          return;
        }

        setActivePeriod(button.getAttribute("data-period"));
      });
    }

    document.addEventListener("visibilitychange", function () {
      if (document.hidden) {
        stopAutoRefresh();
        return;
      }

      if (state.apiConfigured) {
        loadEntries();
        startAutoRefresh();
      }
    });
  }

  async function handleLoginSubmit(event) {
    event.preventDefault();

    if (!state.apiConfigured) {
      showStatus("יש להגדיר חיבור לנתונים לפני הכניסה.", true);
      return;
    }

    var password = elements.passwordInput.value.trim();

    if (!password) {
      showStatus("יש להזין סיסמה.", true);
      elements.passwordInput.focus();
      return;
    }

    setBusy(true, "בודק סיסמה...");

    try {
      var payload = await postAction("login", { password: password });
      saveDeviceToken(payload.deviceToken);
      state.isAdmin = true;
      state.isAdminEntryOpen = true;
      syncAuthUi();
      elements.loginForm.reset();
      showStatus("הכניסה הצליחה. המכשיר הזה נשמר.", false);
    } catch (error) {
      showStatus(error.message || "לא ניתן לבצע כניסה.", true);
    } finally {
      setBusy(false);
    }
  }

  async function handleResultSubmit(event) {
    event.preventDefault();

    if (state.isSavingResult) {
      return;
    }

    if (!state.isAdmin) {
      showStatus("יש להתחבר קודם לאזור הניהול.", true);
      return;
    }

    var playerName = normalizePlayerName(elements.playerNameInput.value);
    var parsedTime = parseTimeInput(elements.timeInput.value);
    var previousBestTimeMs = getPlayerBestTimeMs(playerName, state.entries);

    if (!playerName) {
      showStatus("יש להזין שם שחקן.", true);
      elements.playerNameInput.focus();
      return;
    }

    if (!parsedTime.ok) {
      showStatus(parsedTime.message, true);
      elements.timeInput.focus();
      return;
    }

    state.isSavingResult = true;
    setBusy(true, "שומר תוצאה...");

    try {
      await postAction("add", {
        deviceToken: readDeviceToken(),
        playerName: playerName,
        timeMs: String(parsedTime.timeMs),
        timeDisplay: parsedTime.display
      });

      state.lastSubmittedResult = {
        normalizedName: normalizePlayerName(playerName),
        playerName: playerName,
        timeMs: parsedTime.timeMs,
        previousBestTimeMs: previousBestTimeMs
      };

      elements.resultForm.reset();
      var didReload = await loadEntries();

      if (!didReload) {
        return;
      }

      announceResultSaved(state.lastSubmittedResult);
      highlightPlayer(state.lastSubmittedResult.normalizedName);
      elements.playerNameInput.focus();
    } catch (error) {
      if (isUnauthorizedError(error)) {
        revokeAdminSession();
      }

      showStatus(error.message || "לא ניתן לשמור את התוצאה.", true);
    } finally {
      state.isSavingResult = false;
      setBusy(false);
    }
  }

  function announceResultSaved(result) {
    var filtered = filterEntriesByPeriod(state.entries, state.activePeriod);
    var leaderboard = buildLeaderboard(filtered);
    showStatus(getResultPlacement(result, leaderboard), false);
  }

  function getResultPlacement(result, leaderboard) {
    var placeIndex = leaderboard.findIndex(function (entry) {
      return entry.normalizedName === result.normalizedName;
    });

    if (placeIndex === -1) {
      return "התוצאה נשמרה (לא מופיעה בטווח המוצג).";
    }

    var hadPrevious = Number.isFinite(result.previousBestTimeMs);
    var isPersonalBest = hadPrevious && result.timeMs < result.previousBestTimeMs;
    var base = "התוצאה נשמרה: מקום #" + String(placeIndex + 1);

    if (hadPrevious && result.timeMs > result.previousBestTimeMs) {
      return "התוצאה נשמרה, אך השיא הקודם נשאר טוב יותר.";
    }

    if (isPersonalBest) {
      return base + " · שיא אישי";
    }

    return base;
  }

  function getPlayerBestTimeMs(playerName, entries) {
    var normalizedName = normalizePlayerName(playerName);
    var bestTimeMs = Infinity;

    entries.forEach(function (entry) {
      if (entry.normalizedName === normalizedName && entry.timeMs < bestTimeMs) {
        bestTimeMs = entry.timeMs;
      }
    });

    return bestTimeMs;
  }

  function highlightPlayer(normalizedName) {
    if (highlightTimer) {
      clearTimeout(highlightTimer);
      highlightTimer = null;
    }

    state.highlightedPlayerKey = normalizedName;
    renderAll();

    highlightTimer = setTimeout(function () {
      state.highlightedPlayerKey = null;
      highlightTimer = null;
      renderAll();
    }, 4000);
  }

  async function handleRecentListClick(event) {
    var button = event.target.closest("[data-delete-id]");

    if (!button) {
      return;
    }

    if (!state.isAdmin) {
      showStatus("מחיקה זמינה רק באזור הניהול.", true);
      return;
    }

    var entryId = button.getAttribute("data-delete-id");

    setBusy(true, "מוחק רשומה...");

    try {
      await postAction("delete", {
        deviceToken: readDeviceToken(),
        id: entryId
      });

      showStatus("הרשומה נמחקה.", false);
      await loadEntries();
    } catch (error) {
      if (isUnauthorizedError(error)) {
        revokeAdminSession();
      }

      showStatus(error.message || "לא ניתן למחוק את הרשומה.", true);
    } finally {
      setBusy(false);
    }
  }

  async function loadEntries(forceStatus) {
    setBusy(true, forceStatus ? "מרענן נתונים..." : "");

    try {
      var response = await fetch(buildGetUrl("leaderboard"), {
        method: "GET",
        headers: { Accept: "application/json" }
      });
      var payload = await parseResponse(response);
      state.entries = normalizeEntries(payload.entries || []);
      state.lastUpdatedAt = new Date();
      renderAll();
      renderLastUpdated();

      if (forceStatus) {
        showStatus("הנתונים עודכנו.", false);
      }

      return true;
    } catch (error) {
      state.entries = [];
      renderAll();
      showStatus(error.message || "לא ניתן לטעון נתונים.", true);
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function postAction(action, fields) {
    var formBody = new URLSearchParams();
    formBody.set("action", action);

    Object.keys(fields).forEach(function (key) {
      if (fields[key] !== undefined && fields[key] !== null) {
        formBody.set(key, fields[key]);
      }
    });

    var response = await fetch(apiBaseUrl, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8"
      },
      body: formBody.toString()
    });

    return parseResponse(response);
  }

  async function parseResponse(response) {
    var text = await response.text();
    var payload;

    try {
      payload = text ? JSON.parse(text) : {};
    } catch (error) {
      throw new Error("התקבלה תשובה שלא ניתן לקרוא.");
    }

    if (!response.ok || payload.ok === false) {
      var errorMessage = payload && payload.error ? payload.error : "שגיאת בקשה.";
      var err = new Error(errorMessage);
      err.code = payload && payload.code ? payload.code : "REQUEST_FAILED";
      throw err;
    }

    return payload;
  }

  function normalizeEntries(entries) {
    return entries
      .map(function (entry) {
        return {
          id: String(entry.id || ""),
          playerName: String(entry.playerName || "").trim(),
          normalizedName: normalizePlayerName(entry.playerName),
          timeMs: Number(entry.timeMs || 0),
          timeDisplay: formatTime(Number(entry.timeMs || 0)),
          createdAt: String(entry.createdAt || "")
        };
      })
      .filter(function (entry) {
        return entry.id && entry.playerName && Number.isFinite(entry.timeMs) && entry.timeMs > 0;
      });
  }

  function buildLeaderboard(entries) {
    var grouped = new Map();

    entries.forEach(function (entry) {
      var current = grouped.get(entry.normalizedName);

      if (!current) {
        grouped.set(entry.normalizedName, {
          bestEntry: entry,
          attemptsCount: 1
        });
        return;
      }

      current.attemptsCount += 1;

      if (entry.timeMs < current.bestEntry.timeMs) {
        current.bestEntry = entry;
        return;
      }

      if (entry.timeMs === current.bestEntry.timeMs) {
        var incomingDate = new Date(entry.createdAt).getTime();
        var currentDate = new Date(current.bestEntry.createdAt).getTime();

        if (incomingDate < currentDate) {
          current.bestEntry = entry;
        }
      }
    });

    return Array.from(grouped.values())
      .map(function (item) {
        return {
          id: item.bestEntry.id,
          playerName: item.bestEntry.playerName,
          normalizedName: item.bestEntry.normalizedName,
          timeMs: item.bestEntry.timeMs,
          timeDisplay: item.bestEntry.timeDisplay,
          createdAt: item.bestEntry.createdAt,
          attemptsCount: item.attemptsCount
        };
      })
      .sort(function (a, b) {
        if (a.timeMs !== b.timeMs) {
          return a.timeMs - b.timeMs;
        }

        return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
      });
  }

  function buildRecentEntries(entries) {
    return entries
      .slice()
      .sort(function (a, b) {
        return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
      })
      .slice(0, 12);
  }

  function renderAll() {
    var periodEntries = filterEntriesByPeriod(state.entries, state.activePeriod);
    var leaderboard = buildLeaderboard(periodEntries);
    var recentEntries = buildRecentEntries(periodEntries);

    renderLeaderboard(leaderboard);
    renderRecentEntries(recentEntries);
    renderStats(leaderboard, periodEntries);
  }

  function filterEntriesByPeriod(entries, activePeriod) {
    if (activePeriod === "today") {
      var now = new Date();
      return entries.filter(function (entry) {
        return isSameLocalDay(new Date(entry.createdAt), now);
      });
    }

    if (activePeriod === "week") {
      return entries.filter(function (entry) {
        return isWithinLastDays(new Date(entry.createdAt), 7);
      });
    }

    return entries.slice();
  }

  function isSameLocalDay(dateA, dateB) {
    if (Number.isNaN(dateA.getTime()) || Number.isNaN(dateB.getTime())) {
      return false;
    }

    return (
      dateA.getFullYear() === dateB.getFullYear() &&
      dateA.getMonth() === dateB.getMonth() &&
      dateA.getDate() === dateB.getDate()
    );
  }

  function isWithinLastDays(date, days) {
    if (Number.isNaN(date.getTime())) {
      return false;
    }

    var windowMs = days * 24 * 60 * 60 * 1000;
    return date.getTime() >= Date.now() - windowMs;
  }

  function setActivePeriod(period) {
    var allowed = ["all", "today", "week"];

    if (allowed.indexOf(period) === -1 || period === state.activePeriod) {
      return;
    }

    state.activePeriod = period;
    renderPeriodControls();
    renderWithTransition(renderAll);
  }

  function renderPeriodControls() {
    if (!elements.periodControl) {
      return;
    }

    var buttons = elements.periodControl.querySelectorAll("[data-period]");

    buttons.forEach(function (button) {
      var isActive = button.getAttribute("data-period") === state.activePeriod;
      button.classList.toggle("is-active", isActive);
      button.setAttribute("aria-pressed", isActive ? "true" : "false");
    });
  }

  function renderWithTransition(callback) {
    if (
      prefersReducedMotion() ||
      typeof document.startViewTransition !== "function"
    ) {
      callback();
      return;
    }

    document.startViewTransition(callback);
  }

  function prefersReducedMotion() {
    return Boolean(
      window.matchMedia &&
        window.matchMedia("(prefers-reduced-motion: reduce)").matches
    );
  }

  var rankBadges = ["★", "◆", "●"];

  function renderLeaderboard(leaderboard) {
    elements.leaderboardBody.innerHTML = "";

    if (!leaderboard.length) {
      elements.leaderboardEmpty.textContent = getEmptyLeaderboardText();
      elements.leaderboardEmpty.classList.remove("hidden");
      return;
    }

    elements.leaderboardEmpty.classList.add("hidden");

    leaderboard.forEach(function (entry, index) {
      var row = document.createElement("tr");
      var topClass =
        index === 0
          ? "leaderboard-row-top1"
          : index === 1
            ? "leaderboard-row-top2"
            : index === 2
              ? "leaderboard-row-top3"
              : "";
      var isHighlighted =
        state.highlightedPlayerKey &&
        entry.normalizedName === state.highlightedPlayerKey;

      row.className =
        "leaderboard-row " +
        topClass +
        (isHighlighted ? " leaderboard-row-highlight" : "");

      var badge =
        index < rankBadges.length
          ? '<span class="rank-badge rank-badge-' +
            String(index + 1) +
            '" aria-hidden="true">' +
            rankBadges[index] +
            "</span>"
          : "";

      var deltaText =
        index === 0
          ? "מוביל"
          : "+" +
            ((entry.timeMs - leaderboard[index - 1].timeMs) / 1000).toFixed(2) +
            "s";

      row.innerHTML =
        '<td data-label="מקום"><span class="place-pill">#' +
        String(index + 1) +
        "</span></td>" +
        '<td class="player-cell" data-label="שחקן"><strong>' +
        escapeHtml(entry.playerName) +
        badge +
        '</strong><span class="player-sub"><span class="row-delta">' +
        escapeHtml(deltaText) +
        '</span><span class="sub-sep">·</span>' +
        escapeHtml(formatAttemptsLabel(entry.attemptsCount)) +
        "</span></td>" +
        '<td class="time-cell" data-label="זמן">' +
        escapeHtml(entry.timeDisplay) +
        "</td>" +
        '<td data-label="תאריך">' +
        escapeHtml(formatDate(entry.createdAt)) +
        "</td>";
      elements.leaderboardBody.appendChild(row);
    });
  }

  function getEmptyLeaderboardText() {
    if (state.activePeriod === "today") {
      return "עדיין אין תוצאות היום";
    }

    if (state.activePeriod === "week") {
      return "אין תוצאות ב־7 הימים האחרונים";
    }

    return "עדיין אין תוצאות";
  }

  function renderRecentEntries(entries) {
    elements.recentList.innerHTML = "";

    if (!entries.length) {
      elements.recentEmpty.textContent = getEmptyLeaderboardText();
      elements.recentEmpty.classList.remove("hidden");
      return;
    }

    elements.recentEmpty.classList.add("hidden");

    entries.forEach(function (entry) {
      var card = document.createElement("article");
      card.className = "recent-card";

      var deleteRow = state.isAdmin
        ? '<div class="recent-row recent-actions"><button class="recent-delete" type="button" data-delete-id="' +
          escapeHtml(entry.id) +
          '">מחיקה</button></div>'
        : "";

      card.innerHTML =
        '<div class="recent-row"><div><strong class="recent-name">' +
        escapeHtml(entry.playerName) +
        '</strong><span class="recent-meta">' +
        escapeHtml(formatDate(entry.createdAt)) +
        '</span></div><span class="recent-time">' +
        escapeHtml(entry.timeDisplay) +
        "</span></div>" +
        deleteRow;
      elements.recentList.appendChild(card);
    });
  }

  function renderStats(leaderboard, entries) {
    elements.playersCount.textContent = String(leaderboard.length);
    elements.attemptsCount.textContent = String(entries.length);
    elements.bestTimeValue.textContent = leaderboard.length
      ? leaderboard[0].timeDisplay
      : "--";
  }

  function renderLastUpdated() {
    if (!elements.lastUpdated) {
      return;
    }

    if (!state.apiConfigured) {
      elements.lastUpdated.textContent = "לא מחובר";
      return;
    }

    if (!state.lastUpdatedAt) {
      elements.lastUpdated.textContent = "טוען נתונים";
      return;
    }

    elements.lastUpdated.textContent =
      "עודכן " +
      new Intl.DateTimeFormat("he-IL", {
        hour: "2-digit",
        minute: "2-digit"
      }).format(state.lastUpdatedAt);
  }

  function startAutoRefresh() {
    stopAutoRefresh();

    autoRefreshTimer = setInterval(function () {
      if (shouldSkipAutoRefresh()) {
        return;
      }

      loadEntries();
    }, autoRefreshIntervalMs);
  }

  function stopAutoRefresh() {
    if (autoRefreshTimer) {
      clearInterval(autoRefreshTimer);
      autoRefreshTimer = null;
    }
  }

  function shouldSkipAutoRefresh() {
    return (
      document.hidden ||
      state.isLoading ||
      state.isSavingResult ||
      isAdminFormFocused()
    );
  }

  function isAdminFormFocused() {
    var activeElement = document.activeElement;

    return Boolean(
      activeElement &&
        elements.adminPanel &&
        elements.adminPanel.contains(activeElement) &&
        (activeElement.tagName === "INPUT" || activeElement.tagName === "BUTTON")
    );
  }

  function syncAuthUi() {
    elements.authBox.classList.toggle("hidden", state.isAdmin);
    elements.adminBox.classList.toggle("hidden", !state.isAdmin);
    elements.logoutButton.classList.toggle("hidden", !state.isAdmin);
    elements.adminToggleButton.classList.toggle("hidden", state.isAdmin);
    elements.adminToggleButton.setAttribute(
      "aria-expanded",
      state.isAdmin || state.isAdminEntryOpen ? "true" : "false"
    );
    syncAdminPanelUi();
    renderRecentEntries(
      buildRecentEntries(filterEntriesByPeriod(state.entries, state.activePeriod))
    );
  }

  function syncAdminPanelUi() {
    elements.adminPanel.classList.toggle(
      "hidden",
      !state.isAdmin && !state.isAdminEntryOpen
    );
  }

  function showStatus(message, isError) {
    if (!message) {
      elements.statusBanner.classList.add("hidden");
      elements.statusBanner.textContent = "";
      return;
    }

    elements.statusBanner.classList.remove("hidden");
    elements.statusBanner.textContent = message;
    elements.statusBanner.style.color = isError ? "var(--danger)" : "var(--accent)";
  }

  function setBusy(isBusy, message) {
    state.isLoading = isBusy;
    elements.refreshButton.disabled = isBusy;
    elements.adminToggleButton.disabled = isBusy;

    if (elements.loginForm) {
      elements.loginForm
        .querySelectorAll("button, input")
        .forEach(function (element) {
          element.disabled = isBusy;
        });
    }

    if (elements.resultForm) {
      elements.resultForm
        .querySelectorAll("button, input")
        .forEach(function (element) {
          element.disabled = isBusy;
        });
    }

    if (message) {
      showStatus(message, false);
    }
  }

  function readDeviceToken() {
    return localStorage.getItem(deviceTokenKey) || "";
  }

  function saveDeviceToken(token) {
    localStorage.setItem(deviceTokenKey, token);
  }

  function revokeAdminSession() {
    localStorage.removeItem(deviceTokenKey);
    state.isAdmin = false;
    state.isAdminEntryOpen = false;
    syncAuthUi();
    showStatus("הגישה של המכשיר פגה. יש להתחבר שוב עם סיסמה.", true);
  }

  function buildGetUrl(action) {
    var separator = apiBaseUrl.indexOf("?") === -1 ? "?" : "&";
    return apiBaseUrl + separator + "action=" + encodeURIComponent(action);
  }

  function isApiConfigured(url) {
    return Boolean(url) && !/PASTE_YOUR_/i.test(url);
  }

  function normalizePlayerName(value) {
    return String(value || "").trim().replace(/\s+/g, " ");
  }

  function parseTimeInput(rawValue) {
    var value = String(rawValue || "").trim().replace(",", ".");

    if (!value) {
      return {
        ok: false,
        message: "יש להזין זמן."
      };
    }

    var secondsOnly = /^(\d+)(\.\d{1,2})?$/;
    var minutesPattern = /^(\d+):([0-5]?\d)(\.\d{1,2})?$/;

    if (secondsOnly.test(value)) {
      var seconds = Number(value);
      return buildTimeParseResult(seconds);
    }

    var minutesMatch = value.match(minutesPattern);

    if (minutesMatch) {
      var minutes = Number(minutesMatch[1]);
      var secondsPart = Number(minutesMatch[2] + (minutesMatch[3] || ""));
      return buildTimeParseResult(minutes * 60 + secondsPart);
    }

    return {
      ok: false,
      message: "יש להשתמש בפורמט 12.45 או 1:12.45."
    };
  }

  function buildTimeParseResult(totalSeconds) {
    if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) {
      return {
        ok: false,
        message: "הזמן חייב להיות גדול מאפס."
      };
    }

    var timeMs = Math.round(totalSeconds * 1000);
    return {
      ok: true,
      timeMs: timeMs,
      display: formatTime(timeMs)
    };
  }

  function formatTime(timeMs) {
    var totalHundredths = Math.round(timeMs / 10);
    var minutes = Math.floor(totalHundredths / 6000);
    var seconds = Math.floor((totalHundredths % 6000) / 100);
    var hundredths = totalHundredths % 100;
    var secondsText = String(seconds).padStart(minutes > 0 ? 2 : 1, "0");
    var hundredthsText = String(hundredths).padStart(2, "0");

    if (minutes > 0) {
      return minutes + ":" + secondsText + "." + hundredthsText;
    }

    return secondsText + "." + hundredthsText;
  }

  function formatDate(isoString) {
    var date = new Date(isoString);

    if (Number.isNaN(date.getTime())) {
      return "ללא תאריך";
    }

    return new Intl.DateTimeFormat("he-IL", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit"
    }).format(date);
  }

  function formatAttemptsLabel(attemptsCount) {
    return String(Number(attemptsCount || 0)) + " ניסיונות";
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function isUnauthorizedError(error) {
    return error && (error.code === "UNAUTHORIZED" || error.code === "INVALID_DEVICE");
  }
})();
