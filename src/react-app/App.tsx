import { useState, useEffect, useCallback, useMemo } from "react";
import { marked } from "marked";
import readmeRaw from "../../README.md?raw";
import "./App.css";

interface TenantSummary {
  id: string;
  botToken: string;
  clientId: string;
  clientSecret: string;
  publicKey: string;
  nextId: number;
  guildCount: number;
  channelCount: number;
  createdAt: string;
  logCount: number;
}

interface Channel {
  id: string;
  name: string;
}

interface Guild {
  id: string;
  name: string;
  channels: Channel[];
}

interface TenantDetail {
  id: string;
  botToken: string;
  clientId: string;
  clientSecret: string;
  publicKey: string;
  nextId: number;
  createdAt: string;
  logCount: number;
}

interface AuditLogEntry {
  id: number;
  tenantId?: string | null;
  method: string;
  url: string;
  requestBody: unknown;
  responseStatus: number;
  responseBody: unknown;
  createdAt: string;
}

interface MessagePayload {
  content?: string;
  embeds?: unknown[];
  components?: unknown[];
}

interface MessageEdit {
  payload: MessagePayload;
  editedAt: string;
}

interface Message {
  id: string;
  channelId: string;
  payload: MessagePayload;
  editHistory?: MessageEdit[];
  createdAt: string;
}

interface Reaction {
  channelId: string;
  messageId: string;
  emoji: string;
  createdAt: string;
}

interface InteractionResponse {
  interactionToken: string;
  responseId: string;
  payload: MessagePayload;
  respondedAt: string;
}

interface Followup {
  id: string;
  interactionToken: string;
  payload: MessagePayload;
  createdAt: string;
}

interface TenantState {
  messages: Message[];
  reactions: Reaction[];
  interactionResponses: InteractionResponse[];
  followups: Followup[];
  commands: unknown[];
  authCodes: unknown[];
  accessTokens: unknown[];
  auditLogs: AuditLogEntry[];
}

type View = { type: "list" } | { type: "detail"; tenantId: string } | { type: "docs" };

function DataSection({
  title,
  count,
  children,
}: {
  title: string;
  count: number;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border border-gray-200 dark:border-gray-700 rounded-lg">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-gray-50 dark:hover:bg-gray-800"
      >
        <span className="font-medium text-gray-700 dark:text-gray-300">{title}</span>
        <span className="flex items-center gap-2">
          <span className="bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 text-xs font-medium px-2 py-0.5 rounded-full">
            {count}
          </span>
          <span className="text-gray-400 dark:text-gray-500 text-sm">{open ? "\u25B2" : "\u25BC"}</span>
        </span>
      </button>
      {open && <div className="px-4 pb-4">{children}</div>}
    </div>
  );
}

function JsonView({ data }: { data: unknown }) {
  return (
    <pre className="bg-gray-900 text-green-400 p-4 rounded-lg text-sm overflow-x-auto max-h-96 overflow-y-auto">
      {JSON.stringify(data, null, 2)}
    </pre>
  );
}

function formatRelativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

const METHOD_COLORS: Record<string, string> = {
  GET: "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-300",
  POST: "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-300",
  PATCH: "bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-300",
  PUT: "bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-300",
  DELETE: "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-300",
};

function statusColor(status: number): string {
  if (status < 300) return "text-green-600 dark:text-green-400";
  if (status < 500) return "text-yellow-600 dark:text-yellow-400";
  return "text-red-600 dark:text-red-400";
}

function stripOrigin(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname + u.search;
  } catch {
    return url;
  }
}

function AuditLogList({ logs }: { logs: AuditLogEntry[] }) {
  const [expandedId, setExpandedId] = useState<number | null>(null);

  if (logs.length === 0) {
    return <p className="text-gray-400 italic text-sm">No audit logs</p>;
  }

  return (
    <div className="space-y-1">
      {logs.map((log) => (
        <div key={log.id} className="border border-gray-100 dark:border-gray-800 rounded">
          <button
            onClick={() => setExpandedId(expandedId === log.id ? null : log.id)}
            className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-gray-50 dark:hover:bg-gray-800"
          >
            <span className={`px-1.5 py-0.5 rounded font-mono font-bold text-[10px] ${METHOD_COLORS[log.method] || "bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-300"}`}>
              {log.method}
            </span>
            <span className="font-mono text-gray-700 dark:text-gray-300 truncate flex-1">
              {stripOrigin(log.url)}
            </span>
            <span className={`font-mono font-bold ${statusColor(log.responseStatus)}`}>
              {log.responseStatus}
            </span>
            <span className="text-gray-400 dark:text-gray-500 whitespace-nowrap">
              {formatRelativeTime(log.createdAt)}
            </span>
          </button>
          {expandedId === log.id && (
            <div className="px-3 pb-2 space-y-2">
              {log.requestBody != null && (
                <div>
                  <div className="text-[10px] text-gray-500 dark:text-gray-400 uppercase font-medium mb-1">Request Body</div>
                  <JsonView data={log.requestBody} />
                </div>
              )}
              {log.responseBody != null && (
                <div>
                  <div className="text-[10px] text-gray-500 dark:text-gray-400 uppercase font-medium mb-1">Response Body</div>
                  <JsonView data={log.responseBody} />
                </div>
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return "Today";
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return "Yesterday";
  return d.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
}

function DiscordMessageView({
  messages,
  reactions,
  channels,
  interactionResponses,
  followups,
}: {
  messages: Message[];
  reactions: Reaction[];
  channels: Channel[];
  interactionResponses: InteractionResponse[];
  followups: Followup[];
}) {
  const channelMap = useMemo(() => {
    const m = new Map<string, string>();
    for (const ch of channels) m.set(ch.id, ch.name);
    return m;
  }, [channels]);

  // Group reactions by messageId
  const reactionsByMsg = useMemo(() => {
    const m = new Map<string, Map<string, number>>();
    for (const r of reactions) {
      if (!m.has(r.messageId)) m.set(r.messageId, new Map());
      const emojiMap = m.get(r.messageId)!;
      emojiMap.set(r.emoji, (emojiMap.get(r.emoji) || 0) + 1);
    }
    return m;
  }, [reactions]);

  const INTERACTIONS_CHANNEL = "__interactions__";

  // Build interaction conversation entries (user invocation + bot response + followups)
  interface InteractionEntry {
    id: string;
    command: string | null; // parsed from token like "cmd:ping:001"
    response: InteractionResponse;
    followups: Followup[];
  }

  const interactionEntries = useMemo(() => {
    const followupsByToken = new Map<string, Followup[]>();
    for (const f of followups) {
      if (!followupsByToken.has(f.interactionToken))
        followupsByToken.set(f.interactionToken, []);
      followupsByToken.get(f.interactionToken)!.push(f);
    }
    const entries: InteractionEntry[] = [];
    for (const ir of interactionResponses) {
      // Parse command name from token (format: "cmd:<name>:<id>")
      const parts = ir.interactionToken.split(":");
      const command = parts[0] === "cmd" ? parts[1] : null;
      entries.push({
        id: ir.responseId,
        command,
        response: ir,
        followups: followupsByToken.get(ir.interactionToken) || [],
      });
      followupsByToken.delete(ir.interactionToken);
    }
    return entries;
  }, [interactionResponses, followups]);

  // Group messages by channel, sorted by createdAt
  const channelMessages = useMemo(() => {
    const grouped = new Map<string, Message[]>();
    for (const msg of messages) {
      if (!grouped.has(msg.channelId)) grouped.set(msg.channelId, []);
      grouped.get(msg.channelId)!.push(msg);
    }
    for (const msgs of grouped.values()) {
      msgs.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    }
    return grouped;
  }, [messages]);

  const hasInteractions = interactionResponses.length > 0 || followups.length > 0;

  const [activeChannel, setActiveChannel] = useState<string | null>(null);

  // Default to first channel with messages, or first channel overall
  const selectedChannel = activeChannel
    || (channelMessages.size > 0 ? channelMessages.keys().next().value! : channels[0]?.id);

  const currentMessages = selectedChannel && selectedChannel !== INTERACTIONS_CHANNEL
    ? channelMessages.get(selectedChannel) || []
    : [];

  if (messages.length === 0 && !hasInteractions) {
    return (
      <div className="bg-[#313338] rounded-lg p-8 text-center">
        <p className="text-gray-400 italic">No messages yet</p>
      </div>
    );
  }

  // Get all channels (those with and without messages)
  const allChannelIds = [
    ...channels.map((c) => c.id),
    ...[...channelMessages.keys()].filter(
      (k) => !channels.some((c) => c.id === k)
    ),
  ];

  const channelName = (id: string) =>
    id === INTERACTIONS_CHANNEL ? "interactions" : channelMap.get(id) || id;

  return (
    <div className="bg-[#313338] rounded-lg overflow-hidden flex" style={{ minHeight: 400 }}>
      {/* Channel sidebar */}
      <div className="w-56 bg-[#2b2d31] flex-shrink-0 border-r border-[#1e1f22]">
        <div className="px-3 pt-3 pb-2">
          <div className="text-[11px] font-bold uppercase tracking-wide text-[#949ba4] px-1">
            Channels
          </div>
        </div>
        <div className="space-y-0.5 px-2">
          {[...allChannelIds, ...(hasInteractions ? [INTERACTIONS_CHANNEL] : [])].map((chId) => {
            const name = channelName(chId);
            const msgCount = chId === INTERACTIONS_CHANNEL
              ? interactionEntries.length
              : channelMessages.get(chId)?.length || 0;
            const isActive = chId === selectedChannel;
            const icon = chId === INTERACTIONS_CHANNEL ? "⚡" : "#";
            return (
              <button
                key={chId}
                onClick={() => setActiveChannel(chId)}
                className={`w-full flex items-center gap-1.5 px-2 py-1 rounded text-sm text-left ${
                  isActive
                    ? "bg-[#404249] text-white"
                    : "text-[#949ba4] hover:bg-[#35373c] hover:text-[#dbdee1]"
                }`}
              >
                <span className="text-[#949ba4] text-lg leading-none">{icon}</span>
                <span className="truncate flex-1">{name}</span>
                {msgCount > 0 && (
                  <span className="text-[10px] text-[#949ba4] bg-[#1e1f22] rounded-full px-1.5 py-0.5">
                    {msgCount}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>

      {/* Message area */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Channel header */}
        <div className="h-12 border-b border-[#1e1f22] flex items-center px-4 flex-shrink-0">
          <span className="text-[#949ba4] text-xl mr-1.5">
            {selectedChannel === INTERACTIONS_CHANNEL ? "⚡" : "#"}
          </span>
          <span className="text-white font-semibold">
            {channelName(selectedChannel || "")}
          </span>
        </div>

        {/* Messages / Interactions */}
        <div className="flex-1 overflow-y-auto px-4 py-2 space-y-0">
          {selectedChannel === INTERACTIONS_CHANNEL ? (
            // Render interaction conversations
            interactionEntries.length === 0 ? (
              <div className="flex items-center justify-center h-full">
                <p className="text-[#949ba4] italic">No interactions</p>
              </div>
            ) : (
              interactionEntries.map((entry) => (
                <div key={entry.id} className="mb-2">
                  {/* User invocation */}
                  {entry.command && (
                    <div className="group flex gap-4 py-0.5 hover:bg-[#2e3035] -mx-4 px-4 rounded">
                      <div className="flex-shrink-0 w-10 pt-0.5">
                        <div className="w-10 h-10 rounded-full bg-[#3ba55c] flex items-center justify-center">
                          <span className="text-white text-sm font-bold">U</span>
                        </div>
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-baseline gap-2">
                          <span className="text-[#3ba55c] font-medium">User</span>
                          <span className="text-[11px] text-[#949ba4]">
                            {formatTime(entry.response.respondedAt)}
                          </span>
                        </div>
                        <div className="text-[#dbdee1] text-[15px]">
                          <span className="bg-[#404249] text-[#00aff4] rounded px-1.5 py-0.5 text-sm font-medium">
                            /{entry.command}
                          </span>
                        </div>
                      </div>
                    </div>
                  )}
                  {/* Bot response */}
                  <div className="group flex gap-4 py-0.5 hover:bg-[#2e3035] -mx-4 px-4 rounded">
                    <div className="flex-shrink-0 w-10 pt-0.5">
                      <div className="w-10 h-10 rounded-full bg-[#5865f2] flex items-center justify-center">
                        <span className="text-white text-sm font-bold">B</span>
                      </div>
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-baseline gap-2">
                        <span className="text-[#f2f3f5] font-medium">Bot</span>
                        <span className="inline-flex items-center bg-[#5865f2] text-white text-[10px] font-medium px-1 rounded ml-0.5">APP</span>
                        <span className="text-[11px] text-[#949ba4]">
                          {formatTime(entry.response.respondedAt)}
                        </span>
                      </div>
                      <div className="text-[#dbdee1] text-[15px] leading-relaxed break-words whitespace-pre-wrap">
                        {entry.response.payload.content || (
                          <span className="italic text-[#949ba4]">[no content]</span>
                        )}
                      </div>
                    </div>
                  </div>
                  {/* Followups */}
                  {entry.followups.map((f) => (
                    <div key={f.id} className="group flex gap-4 py-0.5 hover:bg-[#2e3035] -mx-4 px-4 rounded">
                      <div className="flex-shrink-0 w-10 pt-0.5">
                        <div className="w-10 h-10 rounded-full bg-[#5865f2] flex items-center justify-center">
                          <span className="text-white text-sm font-bold">B</span>
                        </div>
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-baseline gap-2">
                          <span className="text-[#f2f3f5] font-medium">Bot</span>
                          <span className="text-[10px] text-[#949ba4] italic">followup</span>
                          <span className="text-[11px] text-[#949ba4]">
                            {formatTime(f.createdAt)}
                          </span>
                        </div>
                        <div className="text-[#dbdee1] text-[15px] leading-relaxed break-words whitespace-pre-wrap">
                          {f.payload.content || (
                            <span className="italic text-[#949ba4]">[no content]</span>
                          )}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              ))
            )
          ) : (
            // Render regular channel messages
            currentMessages.length === 0 ? (
              <div className="flex items-center justify-center h-full">
                <p className="text-[#949ba4] italic">No messages in this channel</p>
              </div>
            ) : (
              currentMessages.map((msg, i) => {
                const prevMsg = i > 0 ? currentMessages[i - 1] : null;
                const isEdited = msg.editHistory && msg.editHistory.length > 0;
                const msgReactions = reactionsByMsg.get(msg.id);
                const showDateDivider =
                  !prevMsg || formatDate(msg.createdAt) !== formatDate(prevMsg.createdAt);

                return (
                  <div key={msg.id}>
                    {showDateDivider && (
                      <div className="flex items-center my-4">
                        <div className="flex-1 border-t border-[#3f4147]" />
                        <span className="px-3 text-[11px] font-semibold text-[#949ba4]">
                          {formatDate(msg.createdAt)}
                        </span>
                        <div className="flex-1 border-t border-[#3f4147]" />
                      </div>
                    )}
                    <div className="group flex gap-4 py-0.5 hover:bg-[#2e3035] -mx-4 px-4 rounded">
                      <div className="flex-shrink-0 w-10 pt-0.5">
                        <div className="w-10 h-10 rounded-full bg-[#5865f2] flex items-center justify-center">
                          <span className="text-white text-sm font-bold">B</span>
                        </div>
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-baseline gap-2">
                          <span className="text-[#f2f3f5] font-medium hover:underline cursor-default">
                            Bot
                          </span>
                          <span className="text-[11px] text-[#949ba4]">
                            {formatTime(msg.createdAt)}
                          </span>
                        </div>
                        <div className="text-[#dbdee1] text-[15px] leading-relaxed break-words">
                          {msg.payload.content || (
                            <span className="italic text-[#949ba4]">[no content]</span>
                          )}
                          {isEdited && (
                            <span className="text-[10px] text-[#949ba4] ml-1" title={`Edited — original: "${msg.editHistory![0].payload.content || ""}"`}>
                              (edited)
                            </span>
                          )}
                        </div>
                        {msgReactions && msgReactions.size > 0 && (
                          <div className="flex gap-1 mt-1 flex-wrap">
                            {[...msgReactions.entries()].map(([emoji, count]) => (
                              <span
                                key={emoji}
                                className="inline-flex items-center gap-1 bg-[#2b2d31] border border-[#3f4147] rounded-full px-2 py-0.5 text-sm"
                              >
                                <span>{emoji}</span>
                                {count > 1 && (
                                  <span className="text-[#dbdee1] text-xs">{count}</span>
                                )}
                              </span>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })
            )
          )}
        </div>
      </div>
    </div>
  );
}

function TenantList({
  tenants,
  onSelect,
}: {
  tenants: TenantSummary[];
  onSelect: (id: string) => void;
}) {
  if (tenants.length === 0) {
    return (
      <p className="text-gray-400 italic text-center py-12">
        No tenants. Create one via POST /_test/tenants
      </p>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-gray-200 dark:border-gray-700 text-left text-gray-500 dark:text-gray-400">
            <th className="py-2 px-3 font-medium">Tenant ID</th>
            <th className="py-2 px-3 font-medium">Client ID</th>
            <th className="py-2 px-3 font-medium">Bot Token</th>
            <th className="py-2 px-3 font-medium text-right">Guilds</th>
            <th className="py-2 px-3 font-medium text-right">Channels</th>
            <th className="py-2 px-3 font-medium text-right">Logs</th>
            <th className="py-2 px-3 font-medium">Created</th>
          </tr>
        </thead>
        <tbody>
          {tenants.map((t) => (
            <tr
              key={t.id}
              onClick={() => onSelect(t.id)}
              className="border-b border-gray-100 dark:border-gray-800 hover:bg-blue-50 dark:hover:bg-gray-800 cursor-pointer"
            >
              <td className="py-2 px-3 font-mono text-xs">{t.id}</td>
              <td className="py-2 px-3 font-mono text-xs">{t.clientId}</td>
              <td className="py-2 px-3 font-mono text-xs">
                {t.botToken.length > 24
                  ? t.botToken.slice(0, 24) + "..."
                  : t.botToken}
              </td>
              <td className="py-2 px-3 text-right">{t.guildCount}</td>
              <td className="py-2 px-3 text-right">{t.channelCount}</td>
              <td className="py-2 px-3 text-right">
                <span className="bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 text-xs font-medium px-2 py-0.5 rounded-full">
                  {t.logCount}
                </span>
              </td>
              <td className="py-2 px-3 text-gray-500 dark:text-gray-400 text-xs whitespace-nowrap">
                {formatRelativeTime(t.createdAt)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function TenantDetailView({
  tenant,
  guilds,
  state,
}: {
  tenant: TenantDetail;
  guilds: Guild[];
  state: TenantState | null;
}) {
  return (
    <div className="space-y-6">
      {/* Config grid */}
      <div>
        <h2 className="text-lg font-semibold text-gray-700 dark:text-gray-200 mb-3">Configuration</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
          {([
            ["Tenant ID", tenant.id],
            ["Client ID", tenant.clientId],
            ["Client Secret", tenant.clientSecret],
            ["Bot Token", tenant.botToken],
            ["Public Key", tenant.publicKey],
            ["Next ID", String(tenant.nextId)],
            ["Created At", tenant.createdAt],
          ] as const).map(([label, value]) => (
            <div key={label} className="bg-gray-50 dark:bg-gray-800 rounded-lg p-3">
              <div className="text-gray-500 dark:text-gray-400 text-xs mb-1">{label}</div>
              <div className="font-mono text-xs break-all text-gray-900 dark:text-gray-100">{value}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Guilds & Channels tree */}
      <div>
        <h2 className="text-lg font-semibold text-gray-700 dark:text-gray-200 mb-3">
          Guilds & Channels
        </h2>
        {guilds.length === 0 ? (
          <p className="text-gray-400 italic">No guilds</p>
        ) : (
          <div className="space-y-2">
            {guilds.map((g) => (
              <div key={g.id} className="border border-gray-200 dark:border-gray-700 rounded-lg p-3">
                <div className="font-medium text-gray-700 dark:text-gray-300">
                  {g.name}{" "}
                  <span className="text-gray-400 dark:text-gray-500 font-mono text-xs">({g.id})</span>
                </div>
                <div className="ml-4 mt-1 space-y-0.5">
                  {g.channels.map((ch) => (
                    <div key={ch.id} className="text-sm text-gray-600 dark:text-gray-400">
                      # {ch.name}{" "}
                      <span className="text-gray-400 dark:text-gray-500 font-mono text-xs">
                        ({ch.id})
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Discord-like message view */}
      {state && (state.messages.length > 0 || state.reactions.length > 0 || state.interactionResponses.length > 0 || state.followups.length > 0) && (
        <div>
          <h2 className="text-lg font-semibold text-gray-700 dark:text-gray-200 mb-3">Messages</h2>
          <DiscordMessageView
            messages={state.messages}
            reactions={state.reactions}
            channels={guilds.flatMap((g) => g.channels)}
            interactionResponses={state.interactionResponses}
            followups={state.followups}
          />
        </div>
      )}

      {/* Mutable state sections */}
      {state && (
        <div>
          <h2 className="text-lg font-semibold text-gray-700 dark:text-gray-200 mb-3">Raw State</h2>
          <div className="space-y-2">
            <DataSection title="Messages" count={state.messages.length}>
              {state.messages.length === 0 ? (
                <p className="text-gray-400 italic text-sm">No messages</p>
              ) : (
                <JsonView data={state.messages} />
              )}
            </DataSection>
            <DataSection title="Reactions" count={state.reactions.length}>
              {state.reactions.length === 0 ? (
                <p className="text-gray-400 italic text-sm">No reactions</p>
              ) : (
                <JsonView data={state.reactions} />
              )}
            </DataSection>
            <DataSection
              title="Interaction Responses"
              count={state.interactionResponses.length}
            >
              {state.interactionResponses.length === 0 ? (
                <p className="text-gray-400 italic text-sm">
                  No interaction responses
                </p>
              ) : (
                <JsonView data={state.interactionResponses} />
              )}
            </DataSection>
            <DataSection title="Followups" count={state.followups.length}>
              {state.followups.length === 0 ? (
                <p className="text-gray-400 italic text-sm">No followups</p>
              ) : (
                <JsonView data={state.followups} />
              )}
            </DataSection>
            <DataSection title="Commands" count={state.commands.length}>
              {state.commands.length === 0 ? (
                <p className="text-gray-400 italic text-sm">No commands</p>
              ) : (
                <JsonView data={state.commands} />
              )}
            </DataSection>
            <DataSection title="Auth Codes" count={state.authCodes.length}>
              {state.authCodes.length === 0 ? (
                <p className="text-gray-400 italic text-sm">No auth codes</p>
              ) : (
                <JsonView data={state.authCodes} />
              )}
            </DataSection>
            <DataSection title="Access Tokens" count={state.accessTokens.length}>
              {state.accessTokens.length === 0 ? (
                <p className="text-gray-400 italic text-sm">No access tokens</p>
              ) : (
                <JsonView data={state.accessTokens} />
              )}
            </DataSection>
            <DataSection title="Audit Logs" count={state.auditLogs.length}>
              <AuditLogList logs={state.auditLogs} />
            </DataSection>
          </div>
        </div>
      )}
    </div>
  );
}

function App() {
  const [view, setView] = useState<View>({ type: "list" });
  const [tenants, setTenants] = useState<TenantSummary[]>([]);
  const [tenantDetail, setTenantDetail] = useState<TenantDetail | null>(null);
  const [guilds, setGuilds] = useState<Guild[]>([]);
  const [tenantState, setTenantState] = useState<TenantState | null>(null);
  const [unassociatedLogs, setUnassociatedLogs] = useState<AuditLogEntry[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchTenants = useCallback(async () => {
    setLoading(true);
    try {
      const [tenantsRes, logsRes] = await Promise.all([
        fetch("/_test/browse/tenants"),
        fetch("/_test/browse/audit-logs?limit=500"),
      ]);
      const tenantsData = await tenantsRes.json();
      const logsData = await logsRes.json();
      const sorted = (tenantsData.tenants as TenantSummary[]).sort(
        (a, b) => b.createdAt.localeCompare(a.createdAt)
      );
      setTenants(sorted);
      setUnassociatedLogs(
        (logsData.logs as AuditLogEntry[]).filter((l) => l.tenantId == null)
      );
    } catch {
      setTenants([]);
      setUnassociatedLogs([]);
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchTenantDetail = useCallback(async (tenantId: string) => {
    setLoading(true);
    try {
      const [detailRes, stateRes] = await Promise.all([
        fetch(`/_test/browse/tenants/${tenantId}`),
        fetch(`/_test/browse/tenants/${tenantId}/state`),
      ]);
      const detailData = await detailRes.json();
      const stateData = await stateRes.json();
      setTenantDetail(detailData.tenant);
      setGuilds(detailData.guilds);
      setTenantState(stateData);
    } catch {
      setTenantDetail(null);
      setGuilds([]);
      setTenantState(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (view.type === "list") {
      fetchTenants();
    } else if (view.type === "detail") {
      fetchTenantDetail(view.tenantId);
    }
  }, [view, fetchTenants, fetchTenantDetail]);

  const handleRefresh = () => {
    if (view.type === "list") {
      fetchTenants();
    } else if (view.type === "detail") {
      fetchTenantDetail(view.tenantId);
    }
  };

  const docsHtml = useMemo(() => marked.parse(readmeRaw) as string, []);

  return (
    <div className="max-w-6xl mx-auto px-4 py-6">
      {/* Top bar */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-bold text-gray-800 dark:text-gray-100">
            Fake Discord
          </h1>
          <div className="text-sm text-gray-500 dark:text-gray-400 mt-1 flex items-center gap-1">
            <button
              onClick={() => setView({ type: "list" })}
              className="hover:text-blue-600 hover:underline"
            >
              Tenants
            </button>
            {view.type === "detail" && (
              <>
                <span>/</span>
                <span className="font-mono text-xs">{view.tenantId}</span>
              </>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <a
            href="https://github.com/glideapps/fake-discord"
            target="_blank"
            rel="noopener noreferrer"
            className="px-3 py-1.5 text-sm bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 rounded-lg text-gray-700 dark:text-gray-300"
          >
            GitHub
          </a>
          <button
            onClick={() => setView({ type: "docs" })}
            className="px-3 py-1.5 text-sm bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 rounded-lg text-gray-700 dark:text-gray-300"
          >
            Docs
          </button>
          {view.type !== "docs" && (
            <button
              onClick={handleRefresh}
              disabled={loading}
              className="px-3 py-1.5 text-sm bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 rounded-lg text-gray-700 dark:text-gray-300 disabled:opacity-50"
            >
              {loading ? "Loading..." : "Refresh"}
            </button>
          )}
        </div>
      </div>

      {/* Content */}
      {view.type === "docs" ? (
        <div
          className="prose prose-sm dark:prose-invert max-w-none"
          dangerouslySetInnerHTML={{ __html: docsHtml }}
        />
      ) : view.type === "list" ? (
        <div className="space-y-8">
          <TenantList
            tenants={tenants}
            onSelect={(id) => setView({ type: "detail", tenantId: id })}
          />
          {unassociatedLogs.length > 0 && (
            <div>
              <h2 className="text-lg font-semibold text-gray-700 dark:text-gray-200 mb-3">
                Unassociated Audit Logs
                <span className="ml-2 text-sm font-normal text-gray-400 dark:text-gray-500">
                  (no tenant — failed auth, unknown routes, etc.)
                </span>
              </h2>
              <DataSection title="Logs" count={unassociatedLogs.length}>
                <AuditLogList logs={unassociatedLogs} />
              </DataSection>
            </div>
          )}
        </div>
      ) : tenantDetail ? (
        <TenantDetailView
          tenant={tenantDetail}
          guilds={guilds}
          state={tenantState}
        />
      ) : loading ? null : (
        <p className="text-gray-400 italic text-center py-12">
          Tenant not found
        </p>
      )}
    </div>
  );
}

export default App;
