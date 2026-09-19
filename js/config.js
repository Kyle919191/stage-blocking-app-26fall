// config.js - Configuration Constants
// Online Blocking Notes

// Debug mode - set to false in production
export const DEBUG_MODE = false;

// Firebase configuration
export const firebaseConfig = {
    apiKey: "AIzaSyBXu8FDjPi8CMdKONGHpMBdIF3_7p6UrAA",
    authDomain: "rctc-fall2026.firebaseapp.com",
    databaseURL: "https://rctc-fall2026-default-rtdb.firebaseio.com",
    projectId: "rctc-fall2026",
    storageBucket: "rctc-fall2026.firebasestorage.app",
    messagingSenderId: "60772001444",
    appId: "1:60772001444:web:f1789d2afe3e4a44b56831",
    measurementId: "G-JFWY5NSC44"
};

// Google Drive upload URL
export const DRIVE_UPLOAD_URL = 'YOUR_GOOGLE_DRIVE_UPLOAD_URL';

// Timeout configuration
export const TIMEOUT_MS = 5000;
export const AUTO_SAVE_DELAY_MS = 1000;

// Version info
export const VERSION = 'v4.5';

// Feature flags - control optional features
export const features = {
    search: false,      // Search functionality
    github: true,       // GitHub integration (sync via Actions)
    versions: true,     // Version management
    pdfExport: true     // PDF export
};

// GitHub Actions trigger configuration
// Frontend no longer stores PAT. GitHub trigger now goes through /api/trigger-sync on server.
export const GITHUB_WORKFLOW_TOKEN = 'SERVER_SIDE_ONLY';
export const GITHUB_REPO = 'SERVER_SIDE_ONLY';
