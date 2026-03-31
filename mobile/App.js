import { CameraView, useCameraPermissions } from "expo-camera";
import React, { useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Linking,
  SafeAreaView,
  StatusBar,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";

// ── Config ────────────────────────────────────────────────────────────────────
const API_BASE_URL = "http://192.168.1.52:8000";
const SCAN_ENDPOINT = `${API_BASE_URL}/api/v1/scan`;
const REQUEST_TIMEOUT_MS = 45_000;

// ── Colours ───────────────────────────────────────────────────────────────────
const C = {
  bg: "#0D0D1A",
  accent: "#E94560",
  textPrimary: "#EAEAEA",
  textMuted: "#7A7A9A",
  blue: "#0047AB",
  green: "#1B5E20",
  white: "#FFFFFF",
};

const S = {
  CAPTURE_GARMENT: "CAPTURE_GARMENT",
  CAPTURE_TAG: "CAPTURE_TAG",
  LOADING: "LOADING",
  RESULT: "RESULT",
};

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
  const [screen, setScreen] = useState(S.CAPTURE_GARMENT);
  const [garmentUri, setGarmentUri] = useState(null);
  const [result, setResult] = useState(null);

  const [permission, requestPermission] = useCameraPermissions();
  const cameraRef = useRef(null);

  const capturePhoto = async () => {
    if (!cameraRef.current) return null;
    const photo = await cameraRef.current.takePictureAsync({ quality: 0.75 });
    return photo.uri;
  };

  const handleGarmentCapture = async () => {
    const uri = await capturePhoto();
    if (!uri) return;
    setGarmentUri(uri);
    setScreen(S.CAPTURE_TAG);
  };

  const handleTagCapture = async () => {
    const tagUri = await capturePhoto();
    if (!tagUri) return;
    setScreen(S.LOADING);
    await submitScan(garmentUri, tagUri);
  };

  const submitScan = async (jacketUri, tagUri) => {
    try {
      const body = new FormData();
      body.append("jacket_image", { uri: jacketUri, name: "jacket.jpg", type: "image/jpeg" });
      body.append("tag_image", { uri: tagUri, name: "tag.jpg", type: "image/jpeg" });

      const response = await fetchWithTimeout(
        SCAN_ENDPOINT,
        { method: "POST", body, headers: { "Content-Type": "multipart/form-data" } },
        REQUEST_TIMEOUT_MS
      );

      if (!response.ok) throw new Error(`Server ${response.status}: ${await response.text()}`);

      const json = await response.json();
      setResult(json.data);
      setScreen(S.RESULT);
    } catch (err) {
      const msg = err.name === "AbortError"
        ? "Request timed out. Check your connection and try again."
        : err.message ?? "Unknown error.";
      Alert.alert("Scan Failed", msg, [
        { text: "Retry", onPress: () => setScreen(S.CAPTURE_GARMENT) },
      ]);
      setScreen(S.CAPTURE_GARMENT);
    }
  };

  const resetApp = () => {
    setGarmentUri(null);
    setResult(null);
    setScreen(S.CAPTURE_GARMENT);
  };

  // ── Permission gate ───────────────────────────────────────────────────────
  if (!permission) {
    return <View style={styles.centered}><ActivityIndicator size="large" color={C.accent} /></View>;
  }

  if (!permission.granted) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.centered}>
          <Text style={styles.permissionText}>Camera access is required to scan items.</Text>
          <TouchableOpacity style={styles.primaryBtn} onPress={requestPermission}>
            <Text style={styles.primaryBtnText}>GRANT CAMERA ACCESS</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  // ══════════════════════════════════════════════════════════════════════════
  // SCREEN: Loading
  // ══════════════════════════════════════════════════════════════════════════
  if (screen === S.LOADING) {
    return (
      <View style={styles.loadingScreen}>
        <ActivityIndicator size="large" color={C.white} />
        <Text style={styles.loadingHeadline}>Analysing Item…</Text>
        <Text style={styles.loadingSubtext}>Querying live market data</Text>
      </View>
    );
  }

  // ══════════════════════════════════════════════════════════════════════════
  // SCREEN: Result
  // ══════════════════════════════════════════════════════════════════════════
  if (screen === S.RESULT && result) {
    const isRestoration = result.pg_restoration_eligible;
    const bg = isRestoration ? C.blue : C.green;

    return (
      <SafeAreaView style={[styles.resultScreen, { backgroundColor: bg }]}>
        <StatusBar barStyle="light-content" backgroundColor={bg} />

        {/* Garment name */}
        <Text style={styles.garmentBrand}>{result.brand}</Text>
        <Text style={styles.garmentModel}>{result.model_name}</Text>

        {/* Price */}
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

        {/* Restoration badge — only shown when eligible */}
        {isRestoration && (
          <View style={styles.restorationBadge}>
            <Text style={styles.restorationBadgeText}>DIVERT TO P&G RESTORATION</Text>
          </View>
        )}

        {/* Condition */}
        <Text style={styles.conditionText}>{result.condition_assessment}</Text>

        {/* View listing */}
        {result.product_url && (
          <TouchableOpacity
            style={styles.listingBtn}
            onPress={() => Linking.openURL(result.product_url)}
            activeOpacity={0.8}
          >
            <Text style={styles.listingBtnText}>VIEW ORIGINAL LISTING</Text>
          </TouchableOpacity>
        )}

        {/* Next item */}
        <TouchableOpacity style={styles.scanNextBtn} onPress={resetApp} activeOpacity={0.8}>
          <Text style={styles.scanNextBtnText}>SCAN NEXT ITEM</Text>
        </TouchableOpacity>
      </SafeAreaView>
    );
  }

  // ══════════════════════════════════════════════════════════════════════════
  // SCREEN: Camera
  // ══════════════════════════════════════════════════════════════════════════
  const isGarmentStep = screen === S.CAPTURE_GARMENT;
  const onCapture = isGarmentStep ? handleGarmentCapture : handleTagCapture;

  return (
    <View style={styles.cameraWrapper}>
      <CameraView style={styles.camera} facing="back" ref={cameraRef}>
        <View style={styles.cameraHud}>
          <Text style={styles.hudStep}>{isGarmentStep ? "STEP 1 OF 2" : "STEP 2 OF 2"}</Text>
          <Text style={styles.hudInstruction}>
            {isGarmentStep
              ? "PHOTOGRAPH THE GARMENT\nCapture the entire item"
              : "PHOTOGRAPH THE TAG\nClose-up of the inner label"}
          </Text>
        </View>
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
  container: { flex: 1, backgroundColor: C.bg },
  centered: { flex: 1, justifyContent: "center", alignItems: "center", padding: 40 },

  permissionText: { fontSize: 22, color: C.textPrimary, textAlign: "center", marginBottom: 32 },
  primaryBtn: { width: "100%", backgroundColor: C.accent, borderRadius: 16, paddingVertical: 28, alignItems: "center" },
  primaryBtnText: { fontSize: 22, color: C.white, fontWeight: "900", letterSpacing: 2 },

  // ── Loading ──────────────────────────────────────────────────────────────
  loadingScreen: {
    flex: 1, backgroundColor: "rgba(0,0,0,0.93)",
    justifyContent: "center", alignItems: "center", gap: 20,
  },
  loadingHeadline: { fontSize: 28, color: C.white, fontWeight: "800" },
  loadingSubtext: { fontSize: 18, color: C.textMuted },

  // ── Result ───────────────────────────────────────────────────────────────
  resultScreen: {
    flex: 1, justifyContent: "center", alignItems: "center", padding: 36, gap: 8,
  },
  garmentBrand: {
    fontSize: 18, fontWeight: "600", color: "rgba(255,255,255,0.75)",
    letterSpacing: 3, textTransform: "uppercase", textAlign: "center",
  },
  garmentModel: {
    fontSize: 34, fontWeight: "900", color: C.white,
    textAlign: "center", letterSpacing: 1, lineHeight: 42,
  },
  metricBlock: { alignItems: "center", marginTop: 20, marginBottom: 4 },
  metricLabel: {
    fontSize: 14, color: "rgba(255,255,255,0.65)",
    fontWeight: "700", letterSpacing: 4, marginBottom: 6,
  },
  metricValue: { fontSize: 80, fontWeight: "900", color: C.white, letterSpacing: 1 },
  restorationBadge: {
    marginTop: 8,
    backgroundColor: "rgba(255,255,255,0.2)",
    borderRadius: 24,
    paddingVertical: 10,
    paddingHorizontal: 24,
  },
  restorationBadgeText: {
    fontSize: 14, fontWeight: "800", color: C.white, letterSpacing: 2,
  },
  conditionText: {
    fontSize: 16, color: "rgba(255,255,255,0.7)",
    textAlign: "center", lineHeight: 24, marginTop: 12, maxWidth: 560,
  },
  listingBtn: {
    marginTop: 20,
    borderWidth: 2, borderColor: "rgba(255,255,255,0.45)",
    borderRadius: 14, paddingVertical: 18, paddingHorizontal: 36,
  },
  listingBtnText: { fontSize: 16, fontWeight: "700", color: C.white, letterSpacing: 2 },
  scanNextBtn: {
    marginTop: 12,
    borderWidth: 3, borderColor: C.white,
    borderRadius: 16, paddingVertical: 26, paddingHorizontal: 52,
  },
  scanNextBtnText: { fontSize: 22, fontWeight: "900", color: C.white, letterSpacing: 3 },

  // ── Camera ───────────────────────────────────────────────────────────────
  cameraWrapper: { flex: 1 },
  camera: { flex: 1, justifyContent: "space-between" },
  cameraHud: {
    backgroundColor: "rgba(0,0,0,0.65)",
    paddingTop: 60, paddingBottom: 28, paddingHorizontal: 32,
    alignItems: "center", gap: 10,
  },
  hudStep: { fontSize: 14, color: C.accent, fontWeight: "800", letterSpacing: 4 },
  hudInstruction: {
    fontSize: 26, color: C.white, fontWeight: "700",
    textAlign: "center", lineHeight: 38,
  },
  cameraFooter: {
    backgroundColor: "rgba(0,0,0,0.65)", paddingVertical: 40, alignItems: "center",
  },
  shutterRing: {
    width: 108, height: 108, borderRadius: 54,
    borderWidth: 5, borderColor: C.white,
    backgroundColor: "rgba(255,255,255,0.2)",
    justifyContent: "center", alignItems: "center",
  },
  shutterDisc: { width: 84, height: 84, borderRadius: 42, backgroundColor: C.white },
});
