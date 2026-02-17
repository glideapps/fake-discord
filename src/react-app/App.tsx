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
}

interface TenantState {
  messages: unknown[];
  reactions: unknown[];
  interactionResponses: unknown[];
  followups: unknown[];
  commands: unknown[];
  authCodes: unknown[];
  accessTokens: unknown[];
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
    <div className="border border-gray-200 rounded-lg">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-gray-50"
      >
        <span className="font-medium text-gray-700">{title}</span>
        <span className="flex items-center gap-2">
          <span className="bg-gray-100 text-gray-600 text-xs font-medium px-2 py-0.5 rounded-full">
            {count}
          </span>
          <span className="text-gray-400 text-sm">{open ? "\u25B2" : "\u25BC"}</span>
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
          <tr className="border-b border-gray-200 text-left text-gray-500">
            <th className="py-2 px-3 font-medium">Tenant ID</th>
            <th className="py-2 px-3 font-medium">Client ID</th>
            <th className="py-2 px-3 font-medium">Bot Token</th>
            <th className="py-2 px-3 font-medium text-right">Guilds</th>
            <th className="py-2 px-3 font-medium text-right">Channels</th>
          </tr>
        </thead>
        <tbody>
          {tenants.map((t) => (
            <tr
              key={t.id}
              onClick={() => onSelect(t.id)}
              className="border-b border-gray-100 hover:bg-blue-50 cursor-pointer"
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
        <h2 className="text-lg font-semibold text-gray-700 mb-3">Configuration</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
          {([
            ["Tenant ID", tenant.id],
            ["Client ID", tenant.clientId],
            ["Client Secret", tenant.clientSecret],
            ["Bot Token", tenant.botToken],
            ["Public Key", tenant.publicKey],
            ["Next ID", String(tenant.nextId)],
          ] as const).map(([label, value]) => (
            <div key={label} className="bg-gray-50 rounded-lg p-3">
              <div className="text-gray-500 text-xs mb-1">{label}</div>
              <div className="font-mono text-xs break-all">{value}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Guilds & Channels tree */}
      <div>
        <h2 className="text-lg font-semibold text-gray-700 mb-3">
          Guilds & Channels
        </h2>
        {guilds.length === 0 ? (
          <p className="text-gray-400 italic">No guilds</p>
        ) : (
          <div className="space-y-2">
            {guilds.map((g) => (
              <div key={g.id} className="border border-gray-200 rounded-lg p-3">
                <div className="font-medium text-gray-700">
                  {g.name}{" "}
                  <span className="text-gray-400 font-mono text-xs">({g.id})</span>
                </div>
                <div className="ml-4 mt-1 space-y-0.5">
                  {g.channels.map((ch) => (
                    <div key={ch.id} className="text-sm text-gray-600">
                      # {ch.name}{" "}
                      <span className="text-gray-400 font-mono text-xs">
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

      {/* Mutable state sections */}
      {state && (
        <div>
          <h2 className="text-lg font-semibold text-gray-700 mb-3">State</h2>
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
  const [loading, setLoading] = useState(true);

  const fetchTenants = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/_test/browse/tenants");
      const data = await res.json();
      setTenants(data.tenants);
    } catch {
      setTenants([]);
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
          <h1 className="text-xl font-bold text-gray-800">
            Fake Discord
          </h1>
          <div className="text-sm text-gray-500 mt-1 flex items-center gap-1">
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
            className="px-3 py-1.5 text-sm bg-gray-100 hover:bg-gray-200 rounded-lg text-gray-700"
          >
            GitHub
          </a>
          <button
            onClick={() => setView({ type: "docs" })}
            className="px-3 py-1.5 text-sm bg-gray-100 hover:bg-gray-200 rounded-lg text-gray-700"
          >
            Docs
          </button>
          {view.type !== "docs" && (
            <button
              onClick={handleRefresh}
              disabled={loading}
              className="px-3 py-1.5 text-sm bg-gray-100 hover:bg-gray-200 rounded-lg text-gray-700 disabled:opacity-50"
            >
              {loading ? "Loading..." : "Refresh"}
            </button>
          )}
        </div>
      </div>

      {/* Content */}
      {view.type === "docs" ? (
        <div
          className="prose prose-sm max-w-none"
          dangerouslySetInnerHTML={{ __html: docsHtml }}
        />
      ) : view.type === "list" ? (
        <TenantList
          tenants={tenants}
          onSelect={(id) => setView({ type: "detail", tenantId: id })}
        />
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
