import { WebSocketServer, WebSocket } from "ws";
import type { Server } from "http";
import type { IncomingMessage } from "http";
import { verifySessionToken } from "../middleware/auth";
import {
  getLiveClient,
  subscribeToMessages,
  subscribeToDialogs,
  subscribeToReadOutbox,
  subscribeToTyping,
  syncMessagesInBackground,
} from "./liveClient";

// How often (ms) to poll for new messages in the active chat as a GramJS event fallback
const SYNC_INTERVAL_MS = 4_000;

export function attachWebSocket(server: Server): void {
  const wss = new WebSocketServer({ server, path: "/ws" });

  wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    const accountId = Number(url.searchParams.get("accountId") ?? "0");

    if (!accountId) {
      ws.close(1008, "Missing accountId");
      return;
    }

    // Authenticate via the first message (not the URL) so tokens never appear in access logs
    const authTimeout = setTimeout(() => {
      ws.close(1008, "Auth timeout");
    }, 5_000);

    ws.once("message", async (rawData: Buffer) => {
      clearTimeout(authTimeout);
      let msg: { type: string; token?: string };
      try {
        msg = JSON.parse(rawData.toString()) as { type: string; token?: string };
      } catch {
        ws.close(1008, "Invalid auth message");
        return;
      }

      if (msg.type !== "auth" || !msg.token) {
        ws.close(1008, "Expected auth message");
        return;
      }

      // Same validation as the HTTP guard: reject captcha/non-session tokens,
      // and block access while a default-password change is still pending
      const decoded = await verifySessionToken(msg.token);
      if (!decoded || decoded.requirePasswordChange) {
        ws.close(1008, "Unauthorised");
        return;
      }

      ws.send(JSON.stringify({ type: "authenticated" }));
      await setupConnection(ws, accountId);
    });
  });
}

async function setupConnection(ws: WebSocket, accountId: number): Promise<void> {
    try {
      await getLiveClient(accountId);
    } catch (err: any) {
      ws.send(JSON.stringify({ type: "error", error: "Failed to connect to Telegram" }));
      ws.close();
      return;
    }

    const unsubscribeMsgs = subscribeToMessages(accountId, (msg) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "message", ...msg }));
      }
    });

    const unsubscribeDialogs = subscribeToDialogs(accountId, (dialogs) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "dialogs", dialogs }));
      }
    });

    const unsubscribeReadOutbox = subscribeToReadOutbox(accountId, (chatId, maxId) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "readOutbox", chatId, maxId }));
      }
    });

    const unsubscribeTyping = subscribeToTyping(accountId, (event) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "typing", ...event }));
      }
    });

    // Track which chat the frontend currently has open
    let activeChatId: string | null = null;

    // Periodic sync -- fallback for when GramJS NewMessage events don't fire
    const syncInterval = setInterval(() => {
      if (activeChatId && ws.readyState === WebSocket.OPEN) {
        syncMessagesInBackground(accountId, activeChatId).catch(() => {});
      }
    }, SYNC_INTERVAL_MS);

    ws.on("message", (rawData: Buffer) => {
      try {
        const data = JSON.parse(rawData.toString()) as {
          type: string;
          chatId?: string;
        };
        if (data.type === "activateChat" && typeof data.chatId === "string") {
          activeChatId = data.chatId;
        }
      } catch {
        /* ignore malformed messages */
      }
    });

    // Native ping/pong keepalive -- terminate if the client stops responding
    let isAlive = true;
    const pingInterval = setInterval(() => {
      if (!isAlive) {
        ws.terminate();
        return;
      }
      isAlive = false;
      ws.ping();
    }, 25_000);

    ws.on("pong", () => {
      isAlive = true;
    });

    const cleanup = () => {
      clearInterval(pingInterval);
      clearInterval(syncInterval);
      unsubscribeMsgs();
      unsubscribeDialogs();
      unsubscribeReadOutbox();
      unsubscribeTyping();
    };

    ws.on("close", cleanup);
    ws.on("error", cleanup);
}
