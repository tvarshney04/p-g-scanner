/**
 * P&G Intelligent Scanner — Expo React Native App
 * ================================================
 * Optimised for iPad warehouse workers wearing gloves.
 * All tap targets are a minimum of 80px tall.
 *
 * Setup:
 *   npx create-expo-app pg-scanner-app
 *   cd pg-scanner-app
 *   npx expo install expo-camera
 *   # Replace the generated App.js with this file
 *   # Set API_BASE_URL below to your server's address
 */

import { CameraView, useCameraPermissions } from "expo-camera";
import React, { useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Modal,
  SafeAreaView,
  StatusBar,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";

// ── Config ────────────────────────────────────────────────────────────────────
// During local development set this to your machine's LAN IP, e.g.
// "http://192.168.1.42:8000". In production point at your Cloud Run URL.
const API_BASE_URL = "http://YOUR_SERVER_IP:8000";
const SCAN_ENDPOINT = `${API_BASE_URL}/api/v1/scan`;
const REQUEST_TIMEOUT_MS = 45_000; // Match the server-side timeout

const FACILITIES = [
  "Ohio Valley Station #1",
  "Ohio Valley Station #2",
  "Ohio Valley Station #3",
  "Ohio Valley Station #4",
  "Great Lakes Hub #1",
  "Southeast Distribution #1",
  "Southwest Hub #2",
];

// ── Colour palette ────────────────────────────────────────────────────────────
const C = {
  bg: "#0D0D1A",
  surface: "#16213E",
  border: "#2A2A4A",
  accent: "#E94560",
  textPrimary: "#EAEAEA",
  textMuted: "#7A7A9A",
  // Decision screens
  blue: "#0047AB",   // P&G restoration
  green: "#1B5E20",  // Standard Goodwill
  white: "#FFFFFF",
};

// ── Screen identifiers ────────────────────────────────────────────────────────
const S = {
  INIT: "INIT",
  CAPTURE_GARMENT: "CAPTURE_GARMENT",
  CAPTURE_TAG: "CAPTURE_TAG",
  LOADING: "LOADING",
  RESULT: "RESULT",
};

// ── Fetch with abort-controller timeout ──────────────────────────────────────
async function fetchWithTimeout(url, options, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ═════════════════════════════════════════════════════════════════════════════
export default function App() {
  const [screen, setScreen] = useState(S.INIT);
  const [facility, setFacility] = useState(null);
  const [showPicker, setShowPicker] = useState(false);
  const [garmentUri, setGarmentUri] = useState(null);
  const [result, setResult] = useState(null);

  const [permission, requestPermission] = useCameraPermissions();
  const cameraRef = useRef(null);

  // ── Capture a photo from the live camera ─────────────────────────────────
  const capturePhoto = async () => {
    if (!cameraRef.current) return null;
    const photo = await cameraRef.current.takePictureAsync({ quality: 0.75 });
    return photo.uri;
  };

  // ── Step A: garment captured → move to tag step ───────────────────────────
  const handleGarmentCapture = async () => {
    const uri = await capturePhoto();
    if (!uri) return;
    setGarmentUri(uri);
    setScreen(S.CAPTURE_TAG);
  };

  // ── Step B: tag captured → submit both to backend ────────────────────────
  const handleTagCapture = async () => {
    const tagUri = await capturePhoto();
    if (!tagUri) return;
    setScreen(S.LOADING);
    await submitScan(garmentUri, tagUri);
  };

  // ── Build FormData and POST to FastAPI ───────────────────────────────────
  const submitScan = async (jacketUri, tagUri) => {
    try {
      const body = new FormData();
      body.append("jacket_image", {
        uri: jacketUri,
        name: "jacket.jpg",
        type: "image/jpeg",
      });
      body.append("tag_image", {
        uri: tagUri,
        name: "tag.jpg",
        type: "image/jpeg",
      });

      const url = facility
        ? `${SCAN_ENDPOINT}?facility=${encodeURIComponent(facility)}`
        : SCAN_ENDPOINT;

      const response = await fetchWithTimeout(
        url,
        { method: "POST", body, headers: { "Content-Type": "multipart/form-data" } },
        REQUEST_TIMEOUT_MS
      );

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Server ${response.status}: ${text}`);
      }

      const json = await response.json();
      setResult(json.data);
      setScreen(S.RESULT);
    } catch (err) {
      const msg =
        err.name === "AbortError"
          ? "Request timed out. Check your network connection and try again."
          : err.message ?? "An unknown error occurred.";

      Alert.alert("Scan Failed", msg, [
        { text: "Retry", onPress: () => setScreen(S.CAPTURE_GARMENT) },
        { text: "Start Over", onPress: resetApp },
      ]);
      setScreen(S.CAPTURE_GARMENT);
    }
  };

  // ── Reset all state for the next item ────────────────────────────────────
  const resetApp = () => {
    setGarmentUri(null);
    setResult(null);
    setScreen(S.CAPTURE_GARMENT);
  };

  // ── Permission gate ───────────────────────────────────────────────────────
  if (!permission) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color={C.accent} />
      </View>
    );
  }

  if (!permission.granted) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.centered}>
          <Text style={styles.permissionText}>
            Camera access is required to scan items.
          </Text>
          <TouchableOpacity style={styles.primaryBtn} onPress={requestPermission}>
            <Text style={styles.primaryBtnText}>GRANT CAMERA ACCESS</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  // ══════════════════════════════════════════════════════════════════════════
  // SCREEN: Station Init
  // ══════════════════════════════════════════════════════════════════════════
  if (screen === S.INIT) {
    return (
      <SafeAreaView style={styles.container}>
        <StatusBar barStyle="light-content" backgroundColor={C.bg} />

        <View style={styles.initBody}>
          <Text style={styles.appTitle}>P&G{"\n"}INTELLIGENT{"\n"}SCANNER</Text>
          <Text style={styles.initSubtitle}>Select your station to begin</Text>

          {/* Facility dropdown trigger */}
          <TouchableOpacity
            style={styles.dropdownTrigger}
            onPress={() => setShowPicker(true)}
            activeOpacity={0.75}
          >
            <Text style={styles.dropdownTriggerText}>
              {facility ?? "TAP TO SELECT FACILITY"}
            </Text>
            <Text style={styles.dropdownCaret}>▼</Text>
          </TouchableOpacity>

          {/* Start button — disabled until a facility is chosen */}
          <TouchableOpacity
            style={[styles.primaryBtn, !facility && styles.btnDisabled]}
            onPress={() => facility && setScreen(S.CAPTURE_GARMENT)}
            disabled={!facility}
            activeOpacity={0.8}
          >
            <Text style={styles.primaryBtnText}>START SCANNING</Text>
          </TouchableOpacity>
        </View>

        {/* Facility picker modal */}
        <Modal visible={showPicker} transparent animationType="slide">
          <View style={styles.modalBackdrop}>
            <View style={styles.modalSheet}>
              <Text style={styles.modalTitle}>Select Facility</Text>

              <FlatList
                data={FACILITIES}
                keyExtractor={(item) => item}
                renderItem={({ item }) => (
                  <TouchableOpacity
                    style={styles.modalRow}
                    onPress={() => {
                      setFacility(item);
                      setShowPicker(false);
                    }}
                    activeOpacity={0.7}
                  >
                    <Text style={styles.modalRowText}>{item}</Text>
                  </TouchableOpacity>
                )}
              />

              <TouchableOpacity
                style={styles.modalCancelBtn}
                onPress={() => setShowPicker(false)}
              >
                <Text style={styles.modalCancelText}>Cancel</Text>
              </TouchableOpacity>
            </View>
          </View>
        </Modal>
      </SafeAreaView>
    );
  }

  // ══════════════════════════════════════════════════════════════════════════
  // SCREEN: Loading overlay
  // ══════════════════════════════════════════════════════════════════════════
  if (screen === S.LOADING) {
    return (
      <View style={styles.loadingScreen}>
        <ActivityIndicator size="large" color={C.white} />
        <Text style={styles.loadingHeadline}>Analysing Item…</Text>
        <Text style={styles.loadingSubtext}>
          Querying live market data for pricing
        </Text>
      </View>
    );
  }

  // ══════════════════════════════════════════════════════════════════════════
  // SCREEN: Decision Result
  // ══════════════════════════════════════════════════════════════════════════
  if (screen === S.RESULT && result) {
    const isRestoration = result.pg_restoration_eligible;
    const bg = isRestoration ? C.blue : C.green;

    return (
      <SafeAreaView style={[styles.resultScreen, { backgroundColor: bg }]}>
        <StatusBar barStyle="light-content" backgroundColor={bg} />

        {/* Primary decision message */}
        <Text style={styles.resultHeadline}>
          {isRestoration ? "DIVERT TO\nP&G RESTORATION" : "STANDARD\nGOODWILL TAG"}
        </Text>

        {/* Key dollar metric */}
        <View style={styles.metricBlock}>
          <Text style={styles.metricLabel}>
            {isRestoration ? "SIZE OF PRIZE" : "AS-IS VALUE"}
          </Text>
          <Text style={styles.metricValue}>
            ${isRestoration
              ? result.size_of_prize?.toFixed(2)
              : result.estimated_as_is_value?.toFixed(2)}
          </Text>
        </View>

        {/* Supporting detail */}
        <View style={styles.detailBlock}>
          <Text style={styles.detailBrand}>
            {result.brand} — {result.model_name}
          </Text>
          <Text style={styles.detailCondition}>{result.condition_assessment}</Text>
        </View>

        {/* Next-item button */}
        <TouchableOpacity style={styles.scanNextBtn} onPress={resetApp} activeOpacity={0.8}>
          <Text style={styles.scanNextBtnText}>SCAN NEXT ITEM</Text>
        </TouchableOpacity>
      </SafeAreaView>
    );
  }

  // ══════════════════════════════════════════════════════════════════════════
  // SCREEN: Camera (garment or tag)
  // ══════════════════════════════════════════════════════════════════════════
  const isGarmentStep = screen === S.CAPTURE_GARMENT;
  const onCapture = isGarmentStep ? handleGarmentCapture : handleTagCapture;

  return (
    <View style={styles.cameraWrapper}>
      <CameraView style={styles.camera} facing="back" ref={cameraRef}>

        {/* Top HUD */}
        <View style={styles.cameraHud}>
          <Text style={styles.hudStep}>
            {isGarmentStep ? "STEP 1 OF 2" : "STEP 2 OF 2"}
          </Text>
          <Text style={styles.hudInstruction}>
            {isGarmentStep
              ? "PHOTOGRAPH THE GARMENT\nCapture the entire item clearly"
              : "PHOTOGRAPH THE TAG\nGet a sharp close-up of the inner label"}
          </Text>
        </View>

        {/* Shutter button — large for gloved hands */}
        <View style={styles.cameraFooter}>
          <TouchableOpacity style={styles.shutterRing} onPress={onCapture} activeOpacity={0.8}>
            <View style={styles.shutterDisc} />
          </TouchableOpacity>
        </View>

      </CameraView>
    </View>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────
const styles = StyleSheet.create({
  // ── Shared ──────────────────────────────────────────────────────────────
  container: { flex: 1, backgroundColor: C.bg },
  centered: { flex: 1, justifyContent: "center", alignItems: "center", padding: 40 },

  // ── Permission screen ────────────────────────────────────────────────────
  permissionText: {
    fontSize: 22,
    color: C.textPrimary,
    textAlign: "center",
    marginBottom: 32,
    lineHeight: 34,
  },

  // ── Init screen ──────────────────────────────────────────────────────────
  initBody: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    paddingHorizontal: 40,
    gap: 28,
  },
  appTitle: {
    fontSize: 44,
    fontWeight: "900",
    color: C.textPrimary,
    textAlign: "center",
    letterSpacing: 4,
    lineHeight: 56,
  },
  initSubtitle: {
    fontSize: 20,
    color: C.textMuted,
    textAlign: "center",
  },
  dropdownTrigger: {
    width: "100%",
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    backgroundColor: C.surface,
    borderWidth: 2,
    borderColor: C.accent,
    borderRadius: 16,
    paddingVertical: 28,
    paddingHorizontal: 24,
  },
  dropdownTriggerText: {
    fontSize: 20,
    color: C.textPrimary,
    fontWeight: "700",
    flex: 1,
  },
  dropdownCaret: { fontSize: 18, color: C.accent },
  primaryBtn: {
    width: "100%",
    backgroundColor: C.accent,
    borderRadius: 16,
    paddingVertical: 28,
    alignItems: "center",
  },
  primaryBtnText: {
    fontSize: 22,
    color: C.white,
    fontWeight: "900",
    letterSpacing: 2,
  },
  btnDisabled: { opacity: 0.35 },

  // ── Facility picker modal ────────────────────────────────────────────────
  modalBackdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.75)",
    justifyContent: "flex-end",
  },
  modalSheet: {
    backgroundColor: C.surface,
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    paddingTop: 24,
    paddingBottom: 40,
    maxHeight: "65%",
  },
  modalTitle: {
    fontSize: 24,
    fontWeight: "800",
    color: C.textPrimary,
    textAlign: "center",
    marginBottom: 12,
    paddingHorizontal: 24,
  },
  modalRow: {
    paddingVertical: 24,
    paddingHorizontal: 32,
    borderBottomWidth: 1,
    borderBottomColor: C.border,
  },
  modalRowText: { fontSize: 20, color: C.textPrimary },
  modalCancelBtn: { paddingVertical: 24, alignItems: "center" },
  modalCancelText: { fontSize: 20, color: C.accent, fontWeight: "700" },

  // ── Loading screen ───────────────────────────────────────────────────────
  loadingScreen: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.93)",
    justifyContent: "center",
    alignItems: "center",
    gap: 24,
  },
  loadingHeadline: {
    fontSize: 28,
    color: C.white,
    fontWeight: "800",
    textAlign: "center",
  },
  loadingSubtext: {
    fontSize: 18,
    color: C.textMuted,
    textAlign: "center",
  },

  // ── Result screen ────────────────────────────────────────────────────────
  resultScreen: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    padding: 40,
    gap: 16,
  },
  resultHeadline: {
    fontSize: 54,
    fontWeight: "900",
    color: C.white,
    textAlign: "center",
    letterSpacing: 2,
    lineHeight: 66,
  },
  metricBlock: { alignItems: "center", marginTop: 16 },
  metricLabel: {
    fontSize: 20,
    color: "rgba(255,255,255,0.75)",
    fontWeight: "700",
    letterSpacing: 4,
    marginBottom: 8,
  },
  metricValue: {
    fontSize: 80,
    fontWeight: "900",
    color: C.white,
    letterSpacing: 1,
  },
  detailBlock: { alignItems: "center", gap: 8, marginTop: 16, maxWidth: 620 },
  detailBrand: {
    fontSize: 22,
    fontWeight: "700",
    color: C.white,
    textAlign: "center",
  },
  detailCondition: {
    fontSize: 18,
    color: "rgba(255,255,255,0.8)",
    textAlign: "center",
    lineHeight: 28,
  },
  scanNextBtn: {
    marginTop: 32,
    borderWidth: 3,
    borderColor: C.white,
    borderRadius: 16,
    paddingVertical: 28,
    paddingHorizontal: 56,
  },
  scanNextBtnText: {
    fontSize: 24,
    fontWeight: "900",
    color: C.white,
    letterSpacing: 3,
  },

  // ── Camera screen ────────────────────────────────────────────────────────
  cameraWrapper: { flex: 1 },
  camera: { flex: 1, justifyContent: "space-between" },
  cameraHud: {
    backgroundColor: "rgba(0,0,0,0.65)",
    paddingTop: 60,
    paddingBottom: 28,
    paddingHorizontal: 32,
    alignItems: "center",
    gap: 10,
  },
  hudStep: {
    fontSize: 16,
    color: C.accent,
    fontWeight: "800",
    letterSpacing: 4,
  },
  hudInstruction: {
    fontSize: 28,
    color: C.white,
    fontWeight: "700",
    textAlign: "center",
    lineHeight: 40,
  },
  cameraFooter: {
    backgroundColor: "rgba(0,0,0,0.65)",
    paddingVertical: 40,
    alignItems: "center",
  },
  // Shutter ring + disc: outer ring is 108px, inner disc is 84px.
  // Deliberately oversized so gloved workers can't miss it.
  shutterRing: {
    width: 108,
    height: 108,
    borderRadius: 54,
    borderWidth: 5,
    borderColor: C.white,
    backgroundColor: "rgba(255,255,255,0.2)",
    justifyContent: "center",
    alignItems: "center",
  },
  shutterDisc: {
    width: 84,
    height: 84,
    borderRadius: 42,
    backgroundColor: C.white,
  },
});
