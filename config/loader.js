// viewer.config loader.
//
// Single source of truth for the viewer's runtime configuration.
// Both vite.config.js (build-time) and src/main.js (runtime fallback)
// read from this.
//
// Each profile carries BOTH:
//   - server-side fields: data_root (filesystem path), url_prefix
//   - browser-side fields: url_prefix, manifest_path, description
// The vite plugin reads everything; the browser build strips
// data_root before injection.
//
// Per-profile url_prefix means the vite plugin can register one
// middleware per profile. Switching profile at runtime = switching
// url_prefix; no server restart required.
//
// Usage (build-time, Node ESM):
//
//   import { getActiveProfile, getAllProfiles, getRuntimeConfig } from
//     './config/loader.js';
//   const all = getAllProfiles();  // for multi-middleware registration
//   const runtime = getRuntimeConfig();  // for browser injection

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

// Built-in fallback when viewer.config.json is missing.
// Matches the shipped viewer.config.json so the viewer still runs
// out-of-the-box.
const DEFAULT_CONFIG = Object.freeze({
    $schema_version: "1.0",
    active_profile: "gallery-tests",
    profiles: {
        "gallery-tests": {
            description: "Visualize kernel-app Gallery outputs via data directory.",
            url_prefix: "/kernel-data",
            manifest_path: "manifest.json",
            data_root: "../kernel-app/data",
        }
    }
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
 * Resolve data_root to an absolute path against the viewer root.
 */
function _resolveDataRoot(root, profile) {
    if (!profile.data_root) return null;
    return path.isAbsolute(profile.data_root)
        ? profile.data_root
        : path.resolve(root, profile.data_root);
}

/**
 * Return the active profile (with absolute data_root resolved against
 * the viewer root). Throws if the active profile name does not exist
 * in the config.
 */
export function getActiveProfile(opts = {}) {
    const cfg = loadViewerConfig(opts);
    return _materialize(cfg, cfg.active_profile, opts);
}

/**
 * Return ALL profiles (active_profile + all listed). Used by the vite
 * plugin to register one middleware per profile.
 */
export function getAllProfiles(opts = {}) {
    const cfg = loadViewerConfig(opts);
    const viewerRoot = path.resolve(process.cwd());
    const out = {};
    for (const name of Object.keys(cfg.profiles || {})) {
        try {
            out[name] = _materialize(cfg, name, opts);
        } catch (e) {
            // Skip invalid profiles but continue with the rest.
            console.warn(`[viewer-config] skipping profile '${name}': ${e.message}`);
        }
    }
    return out;
}

function _materialize(cfg, name, opts) {
    const viewerRoot = path.resolve(process.cwd());
    const profile = cfg.profiles && cfg.profiles[name];
    if (!profile) {
        throw new Error(
            `[viewer-config] profile '${name}' not found in profiles: ` +
            (cfg.profiles ? Object.keys(cfg.profiles).join(', ') : '(none)'));
    }
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
 * Return the JSON-shaped runtime config that the browser needs.
 * Strips data_root (server-only); includes all profile metadata so
 * the browser UI can build the profile picker.
 */
export function getRuntimeConfig(opts = {}) {
    const cfg = loadViewerConfig(opts);
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
        active_profile: cfg.active_profile,
        profiles,
    };
}

// Reset internal cache (tests only).
export function _resetCacheForTest() { _cached = null; }