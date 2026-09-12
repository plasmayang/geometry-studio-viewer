// viewer.config loader.
//
// The viewer runs in ONE of two modes at a time:
//   - mode = "directory": read manifest from a configured filesystem
//     directory. Each profile defines a data root + url_prefix.
//   - mode = "protocol":  run a WebSocket server that accepts pushed
//     data from app(s); broadcast to the connected browser viewer.
//
// Mode is set at config load time. To switch modes, edit
// viewer.config.json and restart the viewer (server + browser).
//
// Build-time use (vite.config.js exposes __VIEWER_CONFIG__ to the
// browser). Runtime use (no further file reads needed).

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

// Built-in fallback when viewer.config.json is missing.
// MUST stay in sync with the shipped file.
const DEFAULT_CONFIG = Object.freeze({
    $schema_version: "1.0",
    mode: "directory",
    profile: "gallery-tests",
    profiles: {
        "gallery-tests": {
            description: "Visualize kernel-app Gallery outputs via data directory.",
            url_prefix: "/kernel-data",
            manifest_path: "gallery_outputs/manifest.json",
            data_root: "../../../30-data/kernel-app",
        }
    },
    server: {
        host: "127.0.0.1",
        port: 8090,
        ingest_path: "/ingest",
        viewer_path: "/viewer",
    },
});

let _cached = null;

/**
 * Read viewer.config.json (or its fallback) and return the parsed object.
 * Cached after the first successful call.
 */
export function loadViewerConfig(opts = {}) {
    if (_cached && !opts.force) return _cached;
    const configPath = opts.configPath ?? path.resolve(process.cwd(), 'viewer.config.json');
    let raw;
    try {
        const text = fs.readFileSync(configPath, 'utf-8');
        raw = JSON.parse(text);
    } catch (e) {
        if (e && e.code === 'ENOENT') {
            console.warn(`[viewer-config] ${configPath} not found; using built-in default.`);
            raw = DEFAULT_CONFIG;
        } else if (e instanceof SyntaxError) {
            throw new Error(`[viewer-config] ${configPath} is not valid JSON: ${e.message}`);
        } else {
            throw e;
        }
    }
    _cached = Object.freeze(raw);
    return _cached;
}

/**
 * Throw if `mode` is not one of the two supported values.
 */
function _validateMode(cfg) {
    if (cfg.mode !== "directory" && cfg.mode !== "protocol") {
        throw new Error(
            `[viewer-config] mode must be 'directory' or 'protocol', got ${JSON.stringify(cfg.mode)}`);
    }
}

/**
 * Resolve the active directory-mode profile. Throws when mode is
 * not 'directory' or the active profile is missing.
 *
 * `opts.profile` overrides the config's default `profile` field,
 * which lets each HTML entry pick its own data source via a
 * `?profile=<name>` query parameter (browser) or an equivalent
 * programmatic override (server).
 */
export function getDirectoryProfile(opts = {}) {
    const cfg = loadViewerConfig(opts);
    _validateMode(cfg);
    if (cfg.mode !== "directory") {
        throw new Error(
            `[viewer-config] getDirectoryProfile() called but mode=${JSON.stringify(cfg.mode)}; expected 'directory'`);
    }
    const name = opts.profile || cfg.profile;
    const profile = cfg.profiles && cfg.profiles[name];
    if (!profile) {
        throw new Error(
            `[viewer-config] active profile '${name}' not found in profiles: ` +
            (cfg.profiles ? Object.keys(cfg.profiles).join(', ') : '(none)'));
    }
    const viewerRoot = path.resolve(process.cwd());
    return {
        name,
        description: profile.description || "",
        url_prefix: profile.url_prefix || "/kernel-data",
        manifest_path: profile.manifest_path || "manifest.json",
        data_root: _resolveDataRoot(viewerRoot, profile),
        data_root_relative: profile.data_root,
    };
}

/**
 * Resolve every directory-mode profile as a list (preserving
 * declaration order). Used by vite.config.js to mount one data
 * bridge per profile so each HTML entry can route to its own
 * data_root via the matching `url_prefix`.
 */
export function listDirectoryProfiles(opts = {}) {
    const cfg = loadViewerConfig(opts);
    _validateMode(cfg);
    if (cfg.mode !== "directory") {
        throw new Error(
            `[viewer-config] listDirectoryProfiles() called but mode=${JSON.stringify(cfg.mode)}; expected 'directory'`);
    }
    const viewerRoot = path.resolve(process.cwd());
    const out = [];
    for (const [name, profile] of Object.entries(cfg.profiles || {})) {
        out.push({
            name,
            description: profile.description || "",
            url_prefix: profile.url_prefix || "/kernel-data",
            manifest_path: profile.manifest_path || "manifest.json",
            data_root: _resolveDataRoot(viewerRoot, profile),
            data_root_relative: profile.data_root,
        });
    }
    return out;
}

/**
 * Resolve the protocol-mode server config. Throws when mode is
 * not 'protocol'.
 */
export function getProtocolServerConfig(opts = {}) {
    const cfg = loadViewerConfig(opts);
    _validateMode(cfg);
    if (cfg.mode !== "protocol") {
        throw new Error(
            `[viewer-config] getProtocolServerConfig() called but mode=${JSON.stringify(cfg.mode)}; expected 'protocol'`);
    }
    const s = cfg.server || {};
    return {
        host: s.host || "127.0.0.1",
        port: typeof s.port === "number" ? s.port : 8090,
        ingest_path: s.ingest_path || "/ingest",
        viewer_path: s.viewer_path || "/viewer",
    };
}

/**
 * Return the JSON-shaped runtime config that the browser needs.
 * Strips server-only fields (data_root absolute paths).
 *
 * Shape depends on mode:
 *   - directory: { mode, profile, profiles: { ... } }
 *   - protocol:  { mode, server: { host, port, ingest_path, viewer_path } }
 */
export function getRuntimeConfig(opts = {}) {
    const cfg = loadViewerConfig(opts);
    _validateMode(cfg);
    if (cfg.mode === "directory") {
        const profiles = {};
        for (const [name, p] of Object.entries(cfg.profiles || {})) {
            profiles[name] = {
                description: p.description || "",
                url_prefix: p.url_prefix || "/kernel-data",
                manifest_path: p.manifest_path || "manifest.json",
            };
        }
        return {
            $schema_version: cfg.$schema_version || "1.0",
            mode: "directory",
            profile: cfg.profile,
            profiles,
        };
    }
    // mode === "protocol"
    const s = cfg.server || {};
    return {
        $schema_version: cfg.$schema_version || "1.0",
        mode: "protocol",
        server: {
            host: s.host || "127.0.0.1",
            port: typeof s.port === "number" ? s.port : 8090,
            ingest_path: s.ingest_path || "/ingest",
            viewer_path: s.viewer_path || "/viewer",
        },
    };
}

function _resolveDataRoot(root, profile) {
    if (!profile.data_root) return null;
    return path.isAbsolute(profile.data_root)
        ? profile.data_root
        : path.resolve(root, profile.data_root);
}

// Reset internal cache (tests only).
export function _resetCacheForTest() { _cached = null; }