
import sql from "mssql";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Row = {
  code: string;
  name: string;
  position: string;
  project: string | null;
  status: string;
  applied: string | null;
  hired: string | null;
};

type Cache = {
  at: number;
  rows: Row[];
};

let cache: Cache | null = null;

async function loadRows(): Promise<Row[]> {
  // Cache database results for 30 seconds.
  if (cache && Date.now() - cache.at < 30_000) {
    return cache.rows;
  }

  const server = process.env.DB_SERVER;
  const database = process.env.DB_NAME;
  const user = process.env.DASH_DB_USER;
  const password = process.env.DASH_DB_PASSWORD;

  if (!server || !database || !user || !password) {
    throw new Error("Missing required Azure SQL environment variables");
  }

  const pool = new sql.ConnectionPool({
    server,
    database,
    user,
    password,
    port: 1433,
    options: {
      encrypt: true,
      trustServerCertificate: false,
    },
    connectionTimeout: 30000,
    requestTimeout: 30000,
    pool: {
      max: 2,
      min: 0,
      idleTimeoutMillis: 10000,
    },
  });

  try {
    await pool.connect();

    const result = await pool
      .request()
      .execute("dbo.usp_get_candidates");

    const formatDate = (value: Date | string | null): string | null => {
      if (!value) return null;

      const date = new Date(value);

      if (Number.isNaN(date.getTime())) {
        return null;
      }

      return date.toISOString().slice(0, 10);
    };

    const rows: Row[] = result.recordset.map((r: any) => ({
      code: String(r.candidate_code ?? ""),
      name: String(r.full_name ?? ""),
      position: String(r.position_applied ?? ""),
      project: r.project == null ? null : String(r.project),
      status: String(r.status ?? ""),
      applied: formatDate(r.applied_on),
      hired: formatDate(r.hired_on),
    }));

    cache = {
      at: Date.now(),
      rows,
    };

    return rows;
  } finally {
    if (pool.connected) {
      await pool.close();
    }
  }
}

function headers(): HeadersInit {
  return {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin":
      process.env.ALLOWED_ORIGIN ?? "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Cache-Control": "no-store",
    Vary: "Origin",
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: headers(),
  });
}

function tally(
  rows: Row[],
  key: "position" | "project"
): [string, number][] {
  const counts = new Map<string, number>();

  for (const row of rows) {
    const value = row[key];

    if (value) {
      counts.set(value, (counts.get(value) ?? 0) + 1);
    }
  }

  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

export async function OPTIONS(): Promise<Response> {
  return new Response(null, {
    status: 204,
    headers: headers(),
  });
}

export async function GET(req: Request): Promise<Response> {
  const params = new URL(req.url).searchParams;

  const project = params.get("project") ?? "";
  const status = params.get("status") ?? "";

  const requestedSize = Number(params.get("size")) || 10;
  const size = Math.min(100, Math.max(1, requestedSize));

  const requestedPage = Number(params.get("page")) || 1;

  let all: Row[];

  try {
    all = await loadRows();
  } catch (error: unknown) {
    // Keep detailed errors in server logs, not public API responses.
    console.error("Azure SQL API error:", error);

    const message =
      error instanceof Error ? error.message : String(error);

    const debugEnabled = process.env.DEBUG_ERRORS === "true";

    return json(
      {
        error: "Data source unavailable",
        ...(debugEnabled ? { detail: message } : {}),
      },
      502
    );
  }

  const byProject = all.filter(
    (row) => !project || row.project === project
  );

  const byStatus = all.filter(
    (row) => !status || row.status === status
  );

  const filtered = byProject.filter(
    (row) => !status || row.status === status
  );

  const pages = Math.max(1, Math.ceil(filtered.length / size));
  const page = Math.min(pages, Math.max(1, requestedPage));

  const stages: Record<string, number> = {};

  for (const row of byProject) {
    stages[row.status] = (stages[row.status] ?? 0) + 1;
  }

  return json({
    total: filtered.length,
    stageTotal: byProject.length,
    page,
    size,
    pages,
    rows: filtered.slice((page - 1) * size, page * size),
    stages,
    positions: tally(filtered, "position"),
    projects: tally(byStatus, "project"),
    projectNames: [
      ...new Set(
        all
          .map((row) => row.project)
          .filter((value): value is string => Boolean(value))
      ),
    ].sort(),
  });
}
