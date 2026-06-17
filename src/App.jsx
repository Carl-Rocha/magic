import { useEffect, useMemo, useState } from "react";
import {
  browserLocalPersistence,
  createUserWithEmailAndPassword,
  GoogleAuthProvider,
  onAuthStateChanged,
  setPersistence,
  signInWithPopup,
  signInWithEmailAndPassword,
  signOut,
} from "firebase/auth";
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  onSnapshot,
  query,
  serverTimestamp,
  setDoc,
} from "firebase/firestore";
import "./App.css";
import heroArtwork from "./assets/background.png";
import heroPanelArtwork from "./assets/hero2.png";
import planeswalkerLogo from "./assets/mtg-crest.svg";
import { auth, firestore, hasFirebaseConfig } from "./firebase";

const LOCAL_USERS_KEY = "magic-local-users";
const LOCAL_SESSION_KEY = "magic-local-session";
const LOCAL_PLAYERS_KEY = "magic-local-players";
const LOCAL_EVENTS_KEY = "magic-local-events";
const ADMIN_EMAIL = "admin@mesademagic.local";
const ADMIN_PASSWORD = "admin123";

const starterPlayers = [
  {
    id: "seed-1",
    uid: "seed-1",
    displayName: "Caio",
    email: "caio@mesa.local",
    nickname: "Value Engine",
    commander: "Atraxa, Praetors Voice",
    commanderManaCost: "{G}{W}{U}{B}",
    commanderOracleText: "Flying, vigilance, deathtouch, lifelink",
    bio: "Joga partidas longas, gosta de value e costuma pilotar decks midrange.",
    commanderImageUrl: "",
  },
  {
    id: "seed-2",
    uid: "seed-2",
    displayName: "Lucas",
    email: "lucas@mesa.local",
    nickname: "Goblin Lord",
    commander: "Krenko, Mob Boss",
    commanderManaCost: "{2}{R}{R}",
    commanderOracleText:
      "{T}: Create X 1/1 red Goblin creature tokens, where X is the number of Goblins you control.",
    bio: "Curte mesa agressiva, snowball rapido e muita pressao desde os primeiros turnos.",
    commanderImageUrl: "",
  },
];

const authInitialState = {
  displayName: "",
  email: "",
  password: "",
};

const profileInitialState = {
  displayName: "",
  nickname: "",
  commander: "",
  bio: "",
};

const profileSteps = [
  { id: "identity", label: "Nome" },
  { id: "commander", label: "Comandante" },
  { id: "bio", label: "Descricao" },
];

const eventInitialState = {
  title: "",
  startsAt: "",
  location: "",
  notes: "",
};

function tokenizeManaCost(manaCost) {
  return manaCost?.match(/\{[^}]+\}/g) ?? [];
}

function getDefaultNextSessionDate(now = new Date()) {
  const target = new Date(now);
  target.setHours(20, 0, 0, 0);

  const day = target.getDay();
  const daysUntilFriday = (5 - day + 7) % 7;

  if (daysUntilFriday === 0 && now < target) {
    return target;
  }

  target.setDate(
    target.getDate() + (daysUntilFriday === 0 ? 7 : daysUntilFriday),
  );
  return target;
}

function getCountdownParts(targetDate) {
  if (!targetDate) {
    return { days: 0, hours: 0, minutes: 0, seconds: 0 };
  }

  const diff = targetDate.getTime() - Date.now();

  if (diff <= 0) {
    return { days: 0, hours: 0, minutes: 0, seconds: 0 };
  }

  return {
    days: Math.floor(diff / (1000 * 60 * 60 * 24)),
    hours: Math.floor((diff / (1000 * 60 * 60)) % 24),
    minutes: Math.floor((diff / (1000 * 60)) % 60),
    seconds: Math.floor((diff / 1000) % 60),
  };
}

function formatUnit(value) {
  return String(value).padStart(2, "0");
}

function formatDateTimeInput(value) {
  if (!value) {
    return "";
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "";
  }

  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${year}-${month}-${day}T${hours}:${minutes}`;
}

function sortEvents(events) {
  return [...events].sort(
    (left, right) =>
      new Date(left.startsAt).getTime() - new Date(right.startsAt).getTime(),
  );
}

function createStarterEvents() {
  const firstEvent = getDefaultNextSessionDate();
  const secondEvent = new Date(firstEvent);
  secondEvent.setDate(secondEvent.getDate() + 7);

  return [
    {
      id: "event-seed-1",
      title: "Commander Night",
      startsAt: firstEvent.toISOString(),
      location: "Mesa de Magic",
      notes: "Levar deck principal, tokens e sleeves.",
    },
    {
      id: "event-seed-2",
      title: "Role extra da mesa",
      startsAt: secondEvent.toISOString(),
      location: "Mesa de Magic",
      notes: "Noite para testar comandantes novos.",
    },
  ];
}

function resolveNextEvent(events) {
  const now = Date.now();
  return (
    sortEvents(events).find(
      (eventItem) => new Date(eventItem.startsAt).getTime() >= now,
    ) ?? null
  );
}

function buildGoogleCalendarUrl(eventItem) {
  if (!eventItem?.startsAt) {
    return "https://calendar.google.com/calendar/render?action=TEMPLATE";
  }

  const sessionDate = new Date(eventItem.startsAt);
  const endDate = new Date(sessionDate.getTime() + 4 * 60 * 60 * 1000);
  const toGoogleDate = (date) =>
    date
      .toISOString()
      .replace(/[-:]/g, "")
      .replace(/\.\d{3}Z$/, "Z");
  const params = new URLSearchParams({
    action: "TEMPLATE",
    text: eventItem.title || "Proxima jogatina da mesa de Magic",
    details:
      eventItem.notes ||
      "Commander night da mesa. Levar deck, sleeves e humor para tomar board wipe.",
    location: eventItem.location || "Mesa de Magic",
    dates: `${toGoogleDate(sessionDate)}/${toGoogleDate(endDate)}`,
    ctz: "America/Sao_Paulo",
  });

  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

function loadLocalUsers() {
  const raw = window.localStorage.getItem(LOCAL_USERS_KEY);

  if (!raw) {
    return [];
  }

  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function loadLocalPlayers() {
  const raw = window.localStorage.getItem(LOCAL_PLAYERS_KEY);

  if (!raw) {
    return starterPlayers;
  }

  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.length > 0 ? parsed : starterPlayers;
  } catch {
    return starterPlayers;
  }
}

function saveLocalPlayers(players) {
  window.localStorage.setItem(LOCAL_PLAYERS_KEY, JSON.stringify(players));
}

function loadLocalEvents() {
  const raw = window.localStorage.getItem(LOCAL_EVENTS_KEY);

  if (!raw) {
    return createStarterEvents();
  }

  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.length > 0
      ? sortEvents(parsed)
      : createStarterEvents();
  } catch {
    return createStarterEvents();
  }
}

function saveLocalEvents(events) {
  window.localStorage.setItem(
    LOCAL_EVENTS_KEY,
    JSON.stringify(sortEvents(events)),
  );
}

function loadLocalSession() {
  const sessionRaw = window.localStorage.getItem(LOCAL_SESSION_KEY);

  if (!sessionRaw) {
    return null;
  }

  try {
    return JSON.parse(sessionRaw);
  } catch {
    return null;
  }
}

function extractCommanderImage(card) {
  if (card.image_uris?.art_crop) {
    return card.image_uris.art_crop;
  }

  if (card.image_uris?.normal) {
    return card.image_uris.normal;
  }

  if (card.card_faces?.[0]?.image_uris?.art_crop) {
    return card.card_faces[0].image_uris.art_crop;
  }

  if (card.card_faces?.[0]?.image_uris?.normal) {
    return card.card_faces[0].image_uris.normal;
  }

  return "";
}

function extractCommanderOracleText(card) {
  if (card.oracle_text) {
    return card.oracle_text;
  }

  if (card.card_faces?.[0]?.oracle_text) {
    return card.card_faces[0].oracle_text;
  }

  return "";
}

async function fetchCommanderCard(commanderName) {
  const response = await fetch(
    `https://api.scryfall.com/cards/named?fuzzy=${encodeURIComponent(commanderName)}`,
  );

  if (!response.ok) {
    throw new Error("commander_not_found");
  }

  const card = await response.json();

  if (card.object === "error") {
    throw new Error("commander_not_found");
  }

  return {
    commander: card.name ?? commanderName,
    commanderManaCost: card.mana_cost ?? "",
    commanderOracleText: extractCommanderOracleText(card),
    commanderImageUrl: extractCommanderImage(card),
  };
}

async function fetchCommanderSuggestions(queryText) {
  const response = await fetch(
    `https://api.scryfall.com/cards/autocomplete?q=${encodeURIComponent(queryText)}`,
  );

  if (!response.ok) {
    throw new Error("autocomplete_failed");
  }

  const data = await response.json();
  return Array.isArray(data.data) ? data.data.slice(0, 8) : [];
}

async function ensureFirebasePlayerDocument(user) {
  if (!firestore || !user) {
    return;
  }

  const playerRef = doc(firestore, "players", user.uid);
  const playerSnapshot = await getDoc(playerRef);

  if (playerSnapshot.exists()) {
    // Atualiza apenas os dados básicos do Google sem apagar o perfil salvo.
    await setDoc(
      playerRef,
      {
        uid: user.uid,
        email: user.email ?? "",
        updatedAt: serverTimestamp(),
      },
      { merge: true },
    );

    return;
  }

  // Cria o perfil vazio somente no primeiro login desse usuário.
  await setDoc(playerRef, {
    uid: user.uid,
    email: user.email ?? "",
    displayName: user.displayName ?? "",
    nickname: "",
    commander: "",
    commanderManaCost: "",
    commanderOracleText: "",
    bio: "",
    commanderImageUrl: "",
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
}

function App() {
  const [authMode, setAuthMode] = useState("login");
  const [authForm, setAuthForm] = useState(authInitialState);
  const [profileForm, setProfileForm] = useState(profileInitialState);
  const [authReady, setAuthReady] = useState(() => {
    const localSession = loadLocalSession();
    return !hasFirebaseConfig || Boolean(localSession?.isAdmin);
  });
  const [authMessage, setAuthMessage] = useState("");
  const [profileMessage, setProfileMessage] = useState("");
  const [players, setPlayers] = useState(() =>
    hasFirebaseConfig ? [] : loadLocalPlayers(),
  );
  const [events, setEvents] = useState(() =>
    hasFirebaseConfig ? [] : loadLocalEvents(),
  );
  const [currentUser, setCurrentUser] = useState(() => loadLocalSession());
  const [profileOpen, setProfileOpen] = useState(false);
  const [adminPanelOpen, setAdminPanelOpen] = useState(false);
  const [profileStep, setProfileStep] = useState(0);
  const [activePlayerIndex, setActivePlayerIndex] = useState(0);
  const [isCommanderEditing, setIsCommanderEditing] = useState(false);
  const [commanderPreview, setCommanderPreview] = useState(null);
  const [commanderLookupState, setCommanderLookupState] = useState("idle");
  const [commanderSuggestions, setCommanderSuggestions] = useState([]);
  const [selectedCommanderName, setSelectedCommanderName] = useState("");
  const [manaSymbols, setManaSymbols] = useState({});
  const [eventForm, setEventForm] = useState(eventInitialState);
  const [eventMessage, setEventMessage] = useState("");
  const [editingEventId, setEditingEventId] = useState(null);
  const [countdown, setCountdown] = useState(() => {
    const initialEvents = hasFirebaseConfig ? [] : loadLocalEvents();
    const initialEvent = resolveNextEvent(initialEvents);
    return getCountdownParts(
      initialEvent ? new Date(initialEvent.startsAt) : null,
    );
  });

  const isAdmin = currentUser?.isAdmin === true;
  const nextEvent = useMemo(() => resolveNextEvent(events), [events]);
  const sessionDate = useMemo(
    () => (nextEvent?.startsAt ? new Date(nextEvent.startsAt) : null),
    [nextEvent],
  );

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      setCountdown(getCountdownParts(sessionDate));
    }, 1000);

    return () => window.clearInterval(intervalId);
  }, [sessionDate]);

  useEffect(() => {
    const controller = new AbortController();

    async function loadManaSymbols() {
      try {
        const response = await fetch("https://api.scryfall.com/symbology", {
          signal: controller.signal,
        });

        if (!response.ok) {
          throw new Error("symbology_failed");
        }

        const data = await response.json();
        setManaSymbols(
          Object.fromEntries(
            (data.data ?? []).map((item) => [item.symbol, item.svg_uri]),
          ),
        );
      } catch (error) {
        if (error.name !== "AbortError") {
          setManaSymbols({});
        }
      }
    }

    loadManaSymbols();

    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (!hasFirebaseConfig || !auth) {
      return undefined;
    }

    const localSession = loadLocalSession();

    if (localSession?.isAdmin) {
      return undefined;
    }

    setPersistence(auth, browserLocalPersistence).catch(() => {});

    const unsubscribe = onAuthStateChanged(auth, (user) => {
      setCurrentUser(user);
      setAuthReady(true);
    });

    return unsubscribe;
  }, []);

  useEffect(() => {
    if (!hasFirebaseConfig || !firestore) {
      return undefined;
    }

    const playersQuery = query(collection(firestore, "players"));
    const unsubscribe = onSnapshot(playersQuery, (snapshot) => {
      setPlayers(
        snapshot.docs.map((snapshotDoc) => ({
          id: snapshotDoc.id,
          ...snapshotDoc.data(),
        })),
      );
    });

    return unsubscribe;
  }, []);

  useEffect(() => {
    if (!hasFirebaseConfig || !firestore) {
      return undefined;
    }

    const eventsQuery = query(collection(firestore, "events"));

    const unsubscribe = onSnapshot(
      eventsQuery,
      (snapshot) => {
        const firebaseEvents = snapshot.docs.map((snapshotDoc) => ({
          id: snapshotDoc.id,
          ...snapshotDoc.data(),
        }));

        setEvents(sortEvents(firebaseEvents));
      },
      (error) => {
        console.error("Erro ao carregar roles:", error);
        setEventMessage("Nao foi possivel carregar os roles.");
      },
    );

    return unsubscribe;
  }, []);

  const currentProfile = useMemo(() => {
    if (!currentUser) {
      return null;
    }

    return (
      players.find(
        (player) =>
          player.uid === currentUser.uid || player.id === currentUser.uid,
      ) ?? null
    );
  }, [currentUser, players]);

  const safeActivePlayerIndex =
    players.length === 0 ? 0 : Math.min(activePlayerIndex, players.length - 1);

  useEffect(() => {
    if (!profileOpen || !isCommanderEditing) {
      return undefined;
    }

    const commanderName = profileForm.commander.trim();

    const timeoutId = window.setTimeout(async () => {
      if (!commanderName) {
        setCommanderSuggestions([]);
        return;
      }

      try {
        const suggestions = await fetchCommanderSuggestions(commanderName);
        setCommanderSuggestions(suggestions);
      } catch {
        setCommanderSuggestions([]);
      }
    }, 320);

    return () => window.clearTimeout(timeoutId);
  }, [isCommanderEditing, profileForm.commander, profileOpen]);

  useEffect(() => {
    if (!profileOpen) {
      return undefined;
    }

    const commanderName = profileForm.commander.trim();

    const timeoutId = window.setTimeout(async () => {
      if (!commanderName || commanderName !== selectedCommanderName) {
        setCommanderPreview(null);
        setCommanderLookupState("idle");
        return;
      }

      setCommanderLookupState("loading");

      try {
        const card = await fetchCommanderCard(commanderName);
        setCommanderPreview(card);
        setCommanderLookupState("success");
      } catch {
        setCommanderPreview(null);
        setCommanderLookupState("error");
      }
    }, 180);

    return () => window.clearTimeout(timeoutId);
  }, [profileForm.commander, profileOpen, selectedCommanderName]);

  const sessionLabel = useMemo(
    () =>
      sessionDate
        ? sessionDate.toLocaleString("pt-BR", {
            weekday: "long",
            day: "2-digit",
            month: "long",
            hour: "2-digit",
            minute: "2-digit",
          })
        : "Sem role agendado",
    [sessionDate],
  );

  function updateAuthField(event) {
    const { name, value } = event.target;
    setAuthForm((current) => ({ ...current, [name]: value }));
  }

  function updateProfileField(event) {
    const { name, value } = event.target;
    setProfileForm((current) => ({ ...current, [name]: value }));

    if (name === "commander") {
      if (!value.trim()) {
        setCommanderSuggestions([]);
      }
      setIsCommanderEditing(true);
      setSelectedCommanderName("");
      setCommanderLookupState(value.trim() ? "idle" : "idle");
    }
  }

  function handleCommanderSuggestionSelect(suggestion) {
    setProfileForm((current) => ({ ...current, commander: suggestion }));
    setCommanderSuggestions([]);
    setSelectedCommanderName(suggestion);
    setIsCommanderEditing(false);
  }

  function updateEventField(event) {
    const { name, value } = event.target;
    setEventForm((current) => ({ ...current, [name]: value }));
  }

  function handlePreviousPlayer() {
    if (players.length <= 1) {
      return;
    }

    setActivePlayerIndex((current) => {
      const safeCurrent = Math.min(current, players.length - 1);
      return safeCurrent === 0 ? players.length - 1 : safeCurrent - 1;
    });
  }

  function handleNextPlayer() {
    if (players.length <= 1) {
      return;
    }

    setActivePlayerIndex((current) => {
      const safeCurrent = Math.min(current, players.length - 1);
      return safeCurrent === players.length - 1 ? 0 : safeCurrent + 1;
    });
  }

  function renderManaCost(manaCost) {
    const tokens = tokenizeManaCost(manaCost);

    if (tokens.length === 0) {
      return null;
    }

    return (
      <div className="mana-cost-row" aria-label={`Custo de mana ${manaCost}`}>
        {tokens.map((token) =>
          manaSymbols[token] ? (
            <img
              key={token}
              className="mana-symbol"
              src={manaSymbols[token]}
              alt={token}
            />
          ) : (
            <span key={token} className="mana-symbol-fallback">
              {token.replace(/[{}]/g, "")}
            </span>
          ),
        )}
      </div>
    );
  }

  function renderOracleText(oracleText) {
    if (!oracleText) {
      return null;
    }

    return oracleText.split("\n").map((line, lineIndex) => (
      <span key={`${line}-${lineIndex}`} className="oracle-line">
        {line
          .split(/(\{[^}]+\})/g)
          .filter(Boolean)
          .map((part, partIndex) =>
            part.startsWith("{") && part.endsWith("}") ? (
              manaSymbols[part] ? (
                <img
                  key={`${part}-${partIndex}`}
                  className="mana-symbol mana-symbol-inline"
                  src={manaSymbols[part]}
                  alt={part}
                />
              ) : (
                <span
                  key={`${part}-${partIndex}`}
                  className="mana-symbol-fallback mana-symbol-inline-fallback"
                >
                  {part.replace(/[{}]/g, "")}
                </span>
              )
            ) : (
              <span key={`${part}-${partIndex}`}>{part}</span>
            ),
          )}
      </span>
    ));
  }

  function renderPlayerCard(player, index) {
    const offset = index - safeActivePlayerIndex;
    const distance = Math.abs(offset);
    const positionClass =
      offset === 0 ? "is-active" : distance === 1 ? "is-near" : "is-far";

    const oracleLength = player.commanderOracleText?.length ?? 0;
    const bioLength = player.bio?.length ?? 0;
    const oracleSizeClass =
      oracleLength > 360
        ? "oracle-text-xs"
        : oracleLength > 240
          ? "oracle-text-sm"
          : oracleLength > 130
            ? "oracle-text-md"
            : "";

    const bioSizeClass =
      bioLength > 520
        ? "player-bio-xs"
        : bioLength > 320
          ? "player-bio-sm"
          : bioLength > 180
            ? "player-bio-md"
            : "";

    return (
      <article
        key={player.id}
        className={`player-card player-carousel-card ${positionClass}`}
        style={{
          "--offset": offset,
          "--distance": distance,
          zIndex: Math.max(1, players.length - distance),
        }}
        onClick={() => setActivePlayerIndex(index)}
        aria-current={offset === 0 ? "true" : undefined}
      >
        <div className="player-avatar">
          {player.commanderImageUrl || player.avatarUrl ? (
            <img
              src={player.commanderImageUrl || player.avatarUrl}
              alt={player.commander || player.displayName}
            />
          ) : (
            <div className="player-avatar-fallback">
              {(player.displayName || "?").slice(0, 1).toUpperCase()}
            </div>
          )}
        </div>

        <div className="player-card-content">
          <span>{player.nickname || "Jogador da mesa"}</span>
          <h3>{player.displayName || "Sem nome"}</h3>
          <strong>{player.commander || "Comandante nao definido"}</strong>

          {renderManaCost(player.commanderManaCost)}

          {offset === 0 && player.commanderOracleText ? (
            <div className={`commander-rules-text ${oracleSizeClass}`}>
              {renderOracleText(player.commanderOracleText)}
            </div>
          ) : null}

          <p className={`player-bio ${bioSizeClass}`}>
            {player.bio || "Sem descricao ainda."}
          </p>
        </div>
      </article>
    );
  }

  function handleToggleProfile() {
    if (isAdmin) {
      return;
    }

    if (profileOpen) {
      setProfileOpen(false);
      return;
    }

    setProfileStep(0);
    setProfileMessage("");
    setCommanderSuggestions([]);
    setProfileForm({
      displayName: currentProfile?.displayName ?? "",
      nickname: currentProfile?.nickname ?? "",
      commander: currentProfile?.commander ?? "",
      bio: currentProfile?.bio ?? "",
    });
    setCommanderPreview(
      currentProfile?.commander
        ? {
            commander: currentProfile.commander,
            commanderManaCost: currentProfile.commanderManaCost ?? "",
            commanderOracleText: currentProfile.commanderOracleText ?? "",
            commanderImageUrl: currentProfile.commanderImageUrl ?? "",
          }
        : null,
    );
    setSelectedCommanderName(currentProfile?.commander ?? "");
    setIsCommanderEditing(!currentProfile?.commander);
    setCommanderLookupState(currentProfile?.commander ? "success" : "idle");
    setProfileOpen(true);
  }

  function handleToggleAdminPanel() {
    if (!isAdmin) {
      return;
    }

    if (adminPanelOpen) {
      setAdminPanelOpen(false);
      setEditingEventId(null);
      setEventForm(eventInitialState);
      setEventMessage("");
      return;
    }

    setProfileOpen(false);
    setCommanderSuggestions([]);
    setEditingEventId(null);
    setEventForm(eventInitialState);
    setEventMessage("");
    setAdminPanelOpen(true);
  }

  function handleEditEvent(eventItem) {
    setEditingEventId(eventItem.id);
    setEventForm({
      title: eventItem.title ?? "",
      startsAt: formatDateTimeInput(eventItem.startsAt),
      location: eventItem.location ?? "",
      notes: eventItem.notes ?? "",
    });
    setEventMessage("");
    setAdminPanelOpen(true);
  }

  async function handleDeleteEvent(eventId) {
    setEventMessage("");

    if (hasFirebaseConfig && firestore) {
      try {
        await deleteDoc(doc(firestore, "events", eventId));
        setEventMessage("Role removido.");
      } catch (error) {
        console.error("Erro ao remover role:", error);
        setEventMessage("Nao foi possivel remover o role.");
        return;
      }
    } else {
      const nextEvents = events.filter((eventItem) => eventItem.id !== eventId);

      setEvents(sortEvents(nextEvents));
      saveLocalEvents(nextEvents);
      setEventMessage("Role removido localmente.");
    }

    if (editingEventId === eventId) {
      setEditingEventId(null);
      setEventForm(eventInitialState);
    }
  }

  async function handleSaveEvent(event) {
    event.preventDefault();
    setEventMessage("");

    if (!eventForm.title.trim() || !eventForm.startsAt) {
      setEventMessage("Preencha titulo e data do role.");
      return;
    }

    const parsedDate = new Date(eventForm.startsAt);

    if (Number.isNaN(parsedDate.getTime())) {
      setEventMessage("Data invalida.");
      return;
    }

    const isEditing = Boolean(editingEventId);
    const eventId = editingEventId ?? `event-${crypto.randomUUID()}`;

    const payload = {
      title: eventForm.title.trim(),
      startsAt: parsedDate.toISOString(),
      location: eventForm.location.trim(),
      notes: eventForm.notes.trim(),
      updatedAt: serverTimestamp(),
    };

    if (hasFirebaseConfig && firestore) {
      try {
        await setDoc(
          doc(firestore, "events", eventId),
          {
            ...payload,
            ...(isEditing ? {} : { createdAt: serverTimestamp() }),
          },
          { merge: true },
        );

        setEditingEventId(null);
        setEventForm(eventInitialState);
        setEventMessage(isEditing ? "Role atualizado." : "Role criado.");
        return;
      } catch (error) {
        console.error("Erro ao salvar role:", error);
        setEventMessage("Nao foi possivel salvar o role.");
        return;
      }
    }

    const localPayload = {
      id: eventId,
      title: payload.title,
      startsAt: payload.startsAt,
      location: payload.location,
      notes: payload.notes,
    };

    const nextEvents = isEditing
      ? events.map((eventItem) =>
          eventItem.id === eventId ? localPayload : eventItem,
        )
      : [...events, localPayload];

    setEvents(sortEvents(nextEvents));
    saveLocalEvents(nextEvents);
    setEditingEventId(null);
    setEventForm(eventInitialState);
    setEventMessage(
      isEditing ? "Role atualizado localmente." : "Role criado localmente.",
    );
  }

  function goToNextProfileStep() {
    setProfileStep((current) => Math.min(current + 1, profileSteps.length - 1));
  }

  function goToPreviousProfileStep() {
    setProfileStep((current) => Math.max(current - 1, 0));
  }

  async function handleAuthSubmit(event) {
    event.preventDefault();
    setAuthMessage("");

    const email = authForm.email.trim();
    const password = authForm.password.trim();
    const displayName = authForm.displayName.trim();

    if (!email || !password) {
      setAuthMessage("Preencha email e senha.");
      return;
    }

    if (
      authMode === "login" &&
      email.toLowerCase() === ADMIN_EMAIL &&
      password === ADMIN_PASSWORD
    ) {
      const adminSession = {
        uid: "mesa-admin",
        email: ADMIN_EMAIL,
        displayName: "Admin da Mesa",
        isAdmin: true,
      };

      window.localStorage.setItem(
        LOCAL_SESSION_KEY,
        JSON.stringify(adminSession),
      );
      setCurrentUser(adminSession);
      setAuthForm(authInitialState);
      setAuthMessage("");
      return;
    }

    if (authMode === "register" && !displayName) {
      setAuthMessage("Preencha seu nome para criar o perfil.");
      return;
    }

    if (authMode === "register" && email.toLowerCase() === ADMIN_EMAIL) {
      setAuthMessage("Esse email e reservado para o admin.");
      return;
    }

    if (hasFirebaseConfig && auth && firestore) {
      try {
        if (authMode === "register") {
          const credentials = await createUserWithEmailAndPassword(
            auth,
            email,
            password,
          );
          await setDoc(doc(firestore, "players", credentials.user.uid), {
            uid: credentials.user.uid,
            email,
            displayName,
            nickname: "",
            commander: "",
            commanderManaCost: "",
            commanderOracleText: "",
            bio: "",
            commanderImageUrl: "",
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });
        } else {
          await signInWithEmailAndPassword(auth, email, password);
        }

        setAuthForm(authInitialState);
        return;
      } catch {
        setAuthMessage(
          authMode === "register"
            ? "Nao foi possivel criar a conta."
            : "Nao foi possivel fazer login.",
        );
        return;
      }
    }

    const localUsers = loadLocalUsers();

    if (authMode === "register") {
      if (localUsers.some((user) => user.email === email)) {
        setAuthMessage("Esse email ja esta cadastrado.");
        return;
      }

      const uid = `local-${crypto.randomUUID()}`;
      const nextUser = { uid, email, password };
      const nextUsers = [...localUsers, nextUser];
      const nextPlayers = [
        {
          id: uid,
          uid,
          email,
          displayName,
          nickname: "",
          commander: "",
          commanderManaCost: "",
          commanderOracleText: "",
          bio: "",
          commanderImageUrl: "",
        },
        ...players,
      ];

      window.localStorage.setItem(LOCAL_USERS_KEY, JSON.stringify(nextUsers));
      window.localStorage.setItem(
        LOCAL_SESSION_KEY,
        JSON.stringify({ uid, email }),
      );
      saveLocalPlayers(nextPlayers);
      setPlayers(nextPlayers);
      setCurrentUser({ uid, email });
      setAuthForm(authInitialState);
      return;
    }

    const foundUser = localUsers.find(
      (user) => user.email === email && user.password === password,
    );

    if (!foundUser) {
      setAuthMessage("Email ou senha invalidos.");
      return;
    }

    window.localStorage.setItem(
      LOCAL_SESSION_KEY,
      JSON.stringify({ uid: foundUser.uid, email: foundUser.email }),
    );
    setCurrentUser({ uid: foundUser.uid, email: foundUser.email });
    setAuthForm(authInitialState);
  }

  async function handleGoogleAuth() {
    setAuthMessage("");

    if (!hasFirebaseConfig || !auth) {
      setAuthMessage("Login com Google precisa do Firebase configurado.");
      return;
    }

    try {
      const provider = new GoogleAuthProvider();
      provider.setCustomParameters({ prompt: "select_account" });

      const credentials = await signInWithPopup(auth, provider);
      await ensureFirebasePlayerDocument(credentials.user);
      setAuthForm(authInitialState);
    } catch {
      setAuthMessage("Nao foi possivel entrar com Google.");
    }
  }

  async function handleSaveProfile(event) {
    event.preventDefault();

    if (!currentUser) {
      return;
    }

    setProfileMessage("");

    const commanderName = profileForm.commander.trim();
    let commanderData = {
      commander: "",
      commanderManaCost: "",
      commanderOracleText: "",
      commanderImageUrl: "",
    };

    if (commanderName && commanderPreview?.commander) {
      commanderData = commanderPreview;
    } else if (commanderName) {
      try {
        commanderData = await fetchCommanderCard(commanderName);
      } catch {
        setProfileMessage("Nao encontrei esse comandante. Confira o nome.");
        return;
      }
    }

    const payload = {
      uid: currentUser.uid,
      email: currentUser.email ?? currentProfile?.email ?? "",
      displayName: profileForm.displayName.trim(),
      nickname: profileForm.nickname.trim(),
      commander: commanderData.commander,
      commanderManaCost: commanderData.commanderManaCost,
      commanderOracleText: commanderData.commanderOracleText,
      bio: profileForm.bio.trim(),
      commanderImageUrl: commanderData.commanderImageUrl,
    };

    if (!payload.displayName) {
      setProfileMessage("Preencha seu nome.");
      return;
    }

    if (hasFirebaseConfig && firestore) {
      try {
        await setDoc(
          doc(firestore, "players", currentUser.uid),
          {
            ...payload,
            updatedAt: serverTimestamp(),
          },
          { merge: true },
        );
        setProfileMessage("Perfil atualizado.");
        return;
      } catch {
        setProfileMessage("Nao foi possivel salvar o perfil.");
        return;
      }
    }

    const nextPlayers = players.some((player) => player.uid === currentUser.uid)
      ? players.map((player) =>
          player.uid === currentUser.uid ? { ...player, ...payload } : player,
        )
      : [{ id: currentUser.uid, ...payload }, ...players];

    setPlayers(nextPlayers);
    saveLocalPlayers(nextPlayers);
    setProfileMessage("Perfil atualizado localmente.");
  }

  async function handleLogout() {
    setProfileOpen(false);
    setAdminPanelOpen(false);
    window.localStorage.removeItem(LOCAL_SESSION_KEY);

    if (currentUser?.isAdmin) {
      setCurrentUser(null);
      return;
    }

    if (hasFirebaseConfig && auth) {
      await signOut(auth);
      return;
    }

    setCurrentUser(null);
  }

  function handleOpenCalendar() {
    window.open(
      buildGoogleCalendarUrl(nextEvent),
      "_blank",
      "noopener,noreferrer",
    );
  }

  if (!authReady) {
    return <div className="loading-screen">Carregando...</div>;
  }

  if (!currentUser) {
    return (
      <div className="login-shell">
        <div className="login-background">
          <img src={heroArtwork} alt="" />
          <div className="login-overlay" />
        </div>

        <div className="login-stack">
          <section className="login-panel">
            <div className="login-brand">
              <img src={planeswalkerLogo} alt="Simbolo de planeswalker" />
              <div>
                <p>MTG Hub</p>
              </div>
            </div>

            <div className="login-copy login-copy-compact">
              <h1>{authMode === "login" ? "Entrar" : "Criar conta"}</h1>
              <p className="login-lead">
                {authMode === "login"
                  ? "Acesse sua mesa."
                  : "Crie seu acesso para entrar na mesa."}
              </p>
            </div>

            <div className="auth-switcher auth-switcher-compact">
              <button
                className={
                  authMode === "login" ? "switch-pill is-active" : "switch-pill"
                }
                type="button"
                onClick={() => setAuthMode("login")}
              >
                Login
              </button>
              <button
                className={
                  authMode === "register"
                    ? "switch-pill is-active"
                    : "switch-pill"
                }
                type="button"
                onClick={() => setAuthMode("register")}
              >
                Criar conta
              </button>
            </div>

            <form className="auth-form-panel" onSubmit={handleAuthSubmit}>
              {authMode === "register" ? (
                <label>
                  Nome
                  <input
                    name="displayName"
                    value={authForm.displayName}
                    onChange={updateAuthField}
                    placeholder="Seu nome na mesa"
                  />
                </label>
              ) : null}

              <label>
                Email
                <input
                  name="email"
                  type="email"
                  value={authForm.email}
                  onChange={updateAuthField}
                  placeholder="voce@mesa.com"
                />
              </label>

              <label>
                Senha
                <input
                  name="password"
                  type="password"
                  value={authForm.password}
                  onChange={updateAuthField}
                  placeholder="Sua senha"
                />
              </label>

              <button className="primary-cta-button auth-submit" type="submit">
                {authMode === "login" ? "Entrar" : "Criar conta"}
              </button>

              {authMessage ? (
                <p className="feedback-text">{authMessage}</p>
              ) : null}
            </form>

            <div className="auth-divider">
              <span>ou</span>
            </div>

            <button
              className="social-auth-button"
              type="button"
              onClick={handleGoogleAuth}
            >
              <span className="social-auth-icon">G</span>
              {authMode === "login"
                ? "Entrar com Google"
                : "Criar conta com Google"}
            </button>
          </section>

          <section className="login-next-session">
            <span>Proximo role</span>
            <strong>
              {nextEvent?.title
                ? `${nextEvent.title} · ${sessionLabel}`
                : sessionLabel}
            </strong>
            <div className="login-mini-countdown">
              <div>
                <b>{formatUnit(countdown.days)}</b>
                <small>d</small>
              </div>
              <div>
                <b>{formatUnit(countdown.hours)}</b>
                <small>h</small>
              </div>
              <div>
                <b>{formatUnit(countdown.minutes)}</b>
                <small>m</small>
              </div>
            </div>
          </section>
        </div>
      </div>
    );
  }

  return (
    <div className="app-shell">
      <div className="app-background">
        <img src={heroArtwork} alt="" />
      </div>
      <div className="texture-overlay" />
      <div className="ambient ambient-left" />
      <div className="ambient ambient-right" />

      <header className="topbar" id="top">
        <div className="brand-lockup">
          <span className="brand-mark">
            <img src={planeswalkerLogo} alt="Simbolo de planeswalker" />
          </span>
          <div>
            <p>Magic dos Cria</p>
            <span>Contador, jogadores e perfil da mesa</span>
          </div>
        </div>

        <div className="topbar-actions">
          {isAdmin ? (
            <button
              className="nav-cta-button"
              type="button"
              onClick={handleToggleAdminPanel}
            >
              Gerenciar roles
            </button>
          ) : null}
          <button
            className="secondary-cta-button"
            type="button"
            onClick={handleOpenCalendar}
            disabled={!nextEvent}
          >
            Salvar jogatina
          </button>
          {!isAdmin ? (
            <button
              className="nav-cta-button"
              type="button"
              onClick={handleToggleProfile}
            >
              Meu perfil
            </button>
          ) : null}
          <button className="ghost-button" type="button" onClick={handleLogout}>
            Sair
          </button>
        </div>
      </header>

      <main className="page">
        <section className="hero-panel">
          <div className="hero-copy">
            <p className="eyebrow">Proxima jogatina</p>
            <h1>Contagem regressiva</h1>
            <br></br>
            <p className="hero-text">
              Assim que o jogador entra, ele ve o proximo encontro, consegue
              salvar a rodada no Google Calendar e acompanha quem ja confirmou a
              mesa.
            </p>

            <div className="flavor-strip">
              <span>Quando</span>
              <p>
                {nextEvent?.title
                  ? `${nextEvent.title} · ${sessionLabel}`
                  : sessionLabel}
              </p>
            </div>

            <div className="countdown-grid">
              <article className="countdown-card">
                <strong>{formatUnit(countdown.days)}</strong>
                <span>Dias</span>
              </article>
              <article className="countdown-card">
                <strong>{formatUnit(countdown.hours)}</strong>
                <span>Horas</span>
              </article>
              <article className="countdown-card">
                <strong>{formatUnit(countdown.minutes)}</strong>
                <span>Min</span>
              </article>
              <article className="countdown-card">
                <strong>{formatUnit(countdown.seconds)}</strong>
                <span>Seg</span>
              </article>
            </div>

            <div className="next-event-description">
              <span>Descrição do evento</span>
              <p>
                {nextEvent?.notes?.trim()
                  ? nextEvent.notes
                  : "Nenhuma descrição cadastrada para este evento."}
              </p>
            </div>
          </div>

          <div className="hero-visual">
            <img className="hero-backdrop" src={heroPanelArtwork} alt="" />
            <div className="hero-card-stack hero-session-panel">
              <span>Mesa atual</span>
              <strong>{players.length} jogadores listados</strong>
              <p>
                A mesa mostra quem ja entrou, qual comandante vai aparecer e
                como cada jogador se apresenta dentro da playgroup.
              </p>
              <div className="session-meta">
                <div>
                  <small>Formato</small>
                  <b>Commander</b>
                </div>
                <div>
                  <small>Local</small>
                  <b>{nextEvent?.location || "Mesa definida pelo admin"}</b>
                </div>
                <div>
                  <small>Status</small>
                  <b>{nextEvent ? "Role agendado" : "Sem agenda"}</b>
                </div>
              </div>
            </div>
          </div>
        </section>

        {profileOpen ? (
          <div
            className="profile-overlay"
            onClick={() => setProfileOpen(false)}
          >
            <section
              className="profile-panel profile-panel-modal"
              onClick={(event) => event.stopPropagation()}
            >
              <div className="profile-modal-topbar">
                <div className="section-heading">
                  <div>
                    <p className="eyebrow">Meu perfil</p>
                    <h2>Prepare seu perfil para a próxima mesa.</h2>
                  </div>
                </div>

                <button
                  className="ghost-button"
                  type="button"
                  onClick={() => setProfileOpen(false)}
                >
                  Fechar
                </button>
              </div>

              <div className="profile-wizard">
                <div className="profile-steps">
                  {profileSteps.map((step, index) => (
                    <button
                      key={step.id}
                      className={
                        index === profileStep
                          ? "profile-step is-active"
                          : index < profileStep
                            ? "profile-step is-complete"
                            : "profile-step"
                      }
                      type="button"
                      onClick={() => setProfileStep(index)}
                    >
                      <span>{String(index + 1).padStart(2, "0")}</span>
                      <strong>{step.label}</strong>
                    </button>
                  ))}
                </div>

                <form
                  className="profile-form profile-form-wizard"
                  onSubmit={handleSaveProfile}
                >
                  <div className="profile-stage">
                    {profileStep === 0 ? (
                      <div className="profile-stage-panel">
                        <p className="eyebrow">Etapa 1</p>
                        <h3>Identidade da mesa</h3>
                        <div className="profile-stage-fields">
                          <label>
                            Nome
                            <input
                              name="displayName"
                              value={profileForm.displayName}
                              onChange={updateProfileField}
                              placeholder="Seu nome"
                            />
                          </label>

                          <label>
                            Apelido
                            <input
                              name="nickname"
                              value={profileForm.nickname}
                              onChange={updateProfileField}
                              placeholder="Seu apelido na mesa"
                            />
                          </label>
                        </div>
                      </div>
                    ) : null}

                    {profileStep === 1 ? (
                      <div className="profile-stage-panel">
                        <p className="eyebrow">Etapa 2</p>
                        <h3>Escolha seu comandante</h3>
                        <div
                          className={
                            isCommanderEditing
                              ? "profile-commander-layout is-editing"
                              : "profile-commander-layout"
                          }
                        >
                          {isCommanderEditing ? (
                            <div className="commander-input-stack commander-input-focus">
                              <label className="full-width">
                                Comandante
                                <input
                                  name="commander"
                                  value={profileForm.commander}
                                  onChange={updateProfileField}
                                  placeholder="Ex.: Kaalia of the Vast"
                                  autoComplete="off"
                                />
                              </label>

                              {commanderSuggestions.length > 0 ? (
                                <div className="commander-suggestions">
                                  {commanderSuggestions
                                    .filter(
                                      (suggestion) =>
                                        suggestion !== selectedCommanderName,
                                    )
                                    .map((suggestion) => (
                                      <button
                                        key={suggestion}
                                        className="commander-suggestion"
                                        type="button"
                                        onClick={() =>
                                          handleCommanderSuggestionSelect(
                                            suggestion,
                                          )
                                        }
                                      >
                                        {suggestion}
                                      </button>
                                    ))}
                                </div>
                              ) : null}
                            </div>
                          ) : null}

                          <div
                            className={
                              isCommanderEditing
                                ? "commander-preview-card commander-preview-card-focus"
                                : "commander-preview-card commander-preview-card-selected"
                            }
                          >
                            <div className="commander-preview-media">
                              {commanderPreview?.commanderImageUrl ? (
                                <img
                                  className="commander-preview-image"
                                  src={commanderPreview.commanderImageUrl}
                                  alt={commanderPreview.commander}
                                />
                              ) : (
                                <div className="commander-preview-fallback">
                                  {commanderLookupState === "loading"
                                    ? "Buscando"
                                    : "Commander"}
                                </div>
                              )}
                            </div>
                            <div className="commander-preview-copy">
                              <span>
                                {commanderLookupState === "loading"
                                  ? "Consultando grimorio"
                                  : commanderLookupState === "error"
                                    ? "Nao encontrado"
                                    : isCommanderEditing
                                      ? "Preview"
                                      : "Comandante escolhido"}
                              </span>
                              <strong>
                                {commanderPreview?.commander ||
                                  profileForm.commander ||
                                  "Seu comandante aparece aqui"}
                              </strong>
                              {renderManaCost(
                                commanderPreview?.commanderManaCost,
                              )}
                              {commanderPreview?.commanderOracleText ? (
                                <div className="commander-rules-text">
                                  {renderOracleText(
                                    commanderPreview.commanderOracleText,
                                  )}
                                </div>
                              ) : null}
                              {profileForm.commander && !isCommanderEditing ? (
                                <button
                                  className="secondary-cta-button commander-edit-button"
                                  type="button"
                                  onClick={() => setIsCommanderEditing(true)}
                                >
                                  Trocar comandante
                                </button>
                              ) : null}
                            </div>
                          </div>
                        </div>
                      </div>
                    ) : null}

                    {profileStep === 2 ? (
                      <div className="profile-stage-panel">
                        <p className="eyebrow">Etapa 3</p>
                        <h3>Sobre você</h3>
                        <label className="full-width">
                          Deixe uma citação legal ou fala como você vai combar
                          <textarea
                            name="bio"
                            rows="5"
                            value={profileForm.bio}
                            onChange={updateProfileField}
                            placeholder="Estilo de mesa, ritmo do deck, o que o grupo pode esperar quando voce senta para jogar..."
                          />
                        </label>
                      </div>
                    ) : null}
                  </div>

                  <div className="profile-wizard-actions">
                    <button
                      className="secondary-cta-button"
                      type="button"
                      onClick={goToPreviousProfileStep}
                      disabled={profileStep === 0}
                    >
                      Voltar
                    </button>

                    {profileStep < profileSteps.length - 1 ? (
                      <button
                        className="primary-cta-button"
                        type="button"
                        onClick={goToNextProfileStep}
                      >
                        Proximo
                      </button>
                    ) : (
                      <button className="primary-cta-button" type="submit">
                        Salvar perfil
                      </button>
                    )}
                  </div>

                  {profileMessage ? (
                    <p className="feedback-text">{profileMessage}</p>
                  ) : null}
                </form>
              </div>
            </section>
          </div>
        ) : null}

        {adminPanelOpen ? (
          <div className="profile-overlay" onClick={handleToggleAdminPanel}>
            <section
              className="profile-panel profile-panel-modal"
              onClick={(event) => event.stopPropagation()}
            >
              <div className="profile-modal-topbar">
                <div className="section-heading">
                  <div>
                    <p className="eyebrow">Painel admin</p>
                    <h2>Crie, edite e remaneje os proximos roles da mesa.</h2>
                  </div>
                </div>

                <button
                  className="ghost-button"
                  type="button"
                  onClick={handleToggleAdminPanel}
                >
                  Fechar
                </button>
              </div>

              <div className="admin-grid">
                <form
                  className="profile-form admin-form"
                  onSubmit={handleSaveEvent}
                >
                  <div className="admin-form-header">
                    <p className="eyebrow">
                      {editingEventId ? "Editando role" : "Novo role"}
                    </p>
                    <h3>
                      {editingEventId
                        ? "Atualize os dados do encontro"
                        : "Cadastre o proximo encontro"}
                    </h3>
                  </div>

                  <label>
                    Titulo
                    <input
                      name="title"
                      value={eventForm.title}
                      onChange={updateEventField}
                      placeholder="Ex.: Commander Night"
                    />
                  </label>

                  <label>
                    Data e hora
                    <input
                      name="startsAt"
                      type="datetime-local"
                      value={eventForm.startsAt}
                      onChange={updateEventField}
                    />
                  </label>

                  <label>
                    Local
                    <input
                      name="location"
                      value={eventForm.location}
                      onChange={updateEventField}
                      placeholder="Ex.: Casa do Caio"
                    />
                  </label>

                  <label>
                    Observacoes
                    <textarea
                      name="notes"
                      rows="4"
                      value={eventForm.notes}
                      onChange={updateEventField}
                      placeholder="Regras da noite, observacoes, itens para levar..."
                    />
                  </label>

                  <div className="form-actions">
                    <button className="primary-cta-button" type="submit">
                      {editingEventId ? "Salvar alteracoes" : "Criar role"}
                    </button>
                    <button
                      className="secondary-cta-button"
                      type="button"
                      onClick={() => {
                        setEditingEventId(null);
                        setEventForm(eventInitialState);
                        setEventMessage("");
                      }}
                    >
                      Limpar
                    </button>
                  </div>

                  {eventMessage ? (
                    <p className="feedback-text">{eventMessage}</p>
                  ) : null}
                </form>

                <div className="admin-list">
                  <div className="admin-form-header">
                    <p className="eyebrow">Agenda</p>
                    <h3>Roles cadastrados</h3>
                  </div>

                  <div className="admin-events">
                    {sortEvents(events).map((eventItem) => (
                      <article key={eventItem.id} className="admin-event-card">
                        <span>{eventItem.location || "Local a definir"}</span>
                        <h3>{eventItem.title}</h3>
                        <strong>
                          {new Date(eventItem.startsAt).toLocaleString(
                            "pt-BR",
                            {
                              weekday: "long",
                              day: "2-digit",
                              month: "long",
                              hour: "2-digit",
                              minute: "2-digit",
                            },
                          )}
                        </strong>
                        <p>{eventItem.notes || "Sem observacoes."}</p>
                        <div className="form-actions">
                          <button
                            className="secondary-cta-button"
                            type="button"
                            onClick={() => handleEditEvent(eventItem)}
                          >
                            Editar
                          </button>
                          <button
                            className="ghost-button"
                            type="button"
                            onClick={() => handleDeleteEvent(eventItem.id)}
                          >
                            Excluir
                          </button>
                        </div>
                      </article>
                    ))}
                  </div>
                </div>
              </div>
            </section>
          </div>
        ) : null}

        <section className="players-section">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Jogadores da mesa</p>
              <h2>Aqui so tem bandido</h2>
            </div>
          </div>

          <div className="players-carousel">
            <button
              className="carousel-arrow carousel-arrow-left"
              type="button"
              onClick={handlePreviousPlayer}
              disabled={players.length <= 1}
              aria-label="Jogador anterior"
            >
              ‹
            </button>

            <div className="players-carousel-viewport">
              <div className="players-carousel-track">
                {players.length > 0 ? (
                  players.map((player, index) =>
                    renderPlayerCard(player, index),
                  )
                ) : (
                  <article className="player-card player-carousel-card is-active player-card-empty">
                    <h3>Nenhum jogador ainda</h3>
                    <p>Crie um perfil para começar a preencher a mesa.</p>
                  </article>
                )}
              </div>

              <div className="carousel-dots" aria-label="Selecionar jogador">
                {players.map((player, index) => (
                  <button
                    key={player.id}
                    type="button"
                    className={
                      index === safeActivePlayerIndex ? "is-active" : ""
                    }
                    onClick={() => setActivePlayerIndex(index)}
                    aria-label={`Mostrar ${player.displayName || `jogador ${index + 1}`}`}
                  />
                ))}
              </div>

              <div className="carousel-status">
                <span>
                  {players.length > 0
                    ? `${safeActivePlayerIndex + 1} / ${players.length}`
                    : "0 / 0"}
                </span>
              </div>
            </div>

            <button
              className="carousel-arrow carousel-arrow-right"
              type="button"
              onClick={handleNextPlayer}
              disabled={players.length <= 1}
              aria-label="Proximo jogador"
            >
              ›
            </button>
          </div>
        </section>
      </main>
    </div>
  );
}

export default App;
