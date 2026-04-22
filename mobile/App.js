import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Animated,
  FlatList,
  Image,
  Linking,
  Modal,
  SafeAreaView,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import {
  Camera,
  useCameraDevices,
  useCameraPermission,
} from "react-native-vision-camera";
import { VolumeManager } from "react-native-volume-manager";
import { manipulateAsync, SaveFormat } from "expo-image-manipulator";

const API_BASE_URL = "https://pg-scanner-158499852321.us-central1.run.app";
const RTDB_URL = "https://pgscanner-4188c-default-rtdb.firebaseio.com";
const SCAN_ENDPOINT = `${API_BASE_URL}/api/v1/scan`;
const CATALOG_ENDPOINT = `${API_BASE_URL}/api/v1/scans`;
const REQUEST_TIMEOUT_MS = 60_000;

const C = {
  bg: "#0A0A14",
  card: "#111120",
  cardBorder: "#1C1C30",
  accent: "#E94560",
  accentSoft: "rgba(233,69,96,0.15)",
  textPrimary: "#F0F0F0",
  textMuted: "#5A5A78",
  textSub: "#9090B0",
  blue: "#2563EB",
  blueSoft: "rgba(37,99,235,0.15)",
  green: "#16A34A",
  greenSoft: "rgba(22,163,74,0.15)",
  white: "#FFFFFF",
};

const S = {
  HOME: "HOME",
  ANALYTICS: "ANALYTICS",
  CAPTURE: "CAPTURE",
  LOADING: "LOADING",
  RESULT: "RESULT",
  DETAIL: "DETAIL",
  BURST_RESULTS: "BURST_RESULTS",
};

const STEP_LABELS = ["Full Garment", "Brand Tag", "Back of Garment"];
const STEP_KEYS = ["garment", "tag", "back"];

const EXPORT_URL = `${API_BASE_URL}/api/v1/scans/export.csv`;

async function fetchWithTimeout(url, options, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ── Fake QR/barcode block ─────────────────────────────────────────────────────
function FakeBarcode() {
  const bars = Array.from({ length: 30 }, (_, i) => ({
    width: [1, 2, 1, 3, 1, 2, 1, 1, 2, 3][i % 10],
    gap: i % 5 === 0 ? 3 : 1,
  }));
  return (
    <View style={tagStyles.barcodeRow}>
      {bars.map((b, i) => (
        <View key={i} style={{ width: b.width, height: 40, backgroundColor: "#111", marginRight: b.gap }} />
      ))}
    </View>
  );
}

// ── Category → header color ───────────────────────────────────────────────────
function tagHeaderColor(category = "") {
  const c = category.toLowerCase();
  if (c.includes("women")) return "#E85D8A";      // pink
  if (c.includes("men"))   return "#2A7DC9";      // blue
  if (c.includes("kids"))  return "#4CAF50";      // green
  if (c.includes("shoes")) return c.includes("women") ? "#E85D8A" : "#2A7DC9";
  if (c.includes("electronics")) return "#9C27B0"; // purple
  if (c.includes("wares")) return "#FF7043";       // orange
  return "#F5C800";                                // default yellow
}

// ── Goodwill Tag Modal ────────────────────────────────────────────────────────
function GoodwillTagModal({ visible, item, onClose }) {
  const slideAnim = useRef(new Animated.Value(600)).current;
  const bgAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (visible) {
      Animated.parallel([
        Animated.spring(slideAnim, { toValue: 0, useNativeDriver: true, tension: 70, friction: 12 }),
        Animated.timing(bgAnim, { toValue: 1, duration: 200, useNativeDriver: true }),
      ]).start();
    } else {
      Animated.parallel([
        Animated.timing(slideAnim, { toValue: 600, duration: 220, useNativeDriver: true }),
        Animated.timing(bgAnim, { toValue: 0, duration: 200, useNativeDriver: true }),
      ]).start();
    }
  }, [visible]);

  if (!item) return null;

  const bgOpacity = bgAnim.interpolate({ inputRange: [0, 1], outputRange: [0, 0.5] });

  return (
    <Modal transparent visible={visible} animationType="none" onRequestClose={onClose}>
      {/* Dimmed backdrop */}
      <Animated.View style={[tagStyles.backdrop, { opacity: bgOpacity }]} />

      {/* Tag card */}
      <Animated.View style={[tagStyles.wrapper, { transform: [{ translateY: slideAnim }] }]}>
        <View style={tagStyles.card}>
          {/* Back button */}
          <TouchableOpacity style={tagStyles.backBtn} onPress={onClose} activeOpacity={0.7}>
            <Text style={tagStyles.backText}>✕</Text>
          </TouchableOpacity>

          {/* Color-coded header */}
          <View style={[tagStyles.header, { backgroundColor: tagHeaderColor(item.category) }]}>
            <Text style={[tagStyles.headerTitle, { color: item.category?.toLowerCase().includes("men") && !item.category?.toLowerCase().includes("women") ? "#fff" : "#111" }]}>GOODWILL</Text>
          </View>

          {/* Category + brand */}
          <View style={tagStyles.categoryBlock}>
            <Text style={tagStyles.categoryText}>{item.category || "Clothing"}</Text>
            <Text style={tagStyles.garmentTypeText}>{item.brand}</Text>
          </View>

          {/* Divider */}
          <View style={tagStyles.divider} />

          {/* Size + Price */}
          <View style={tagStyles.detailBlock}>
            <Text style={tagStyles.sizeLabel}>Size  <Text style={tagStyles.sizeValue}>{item.size || "—"}</Text></Text>
            <Text style={tagStyles.priceValue}>${item.estimated_as_is_value?.toFixed(2)}</Text>
          </View>

          {/* Divider */}
          <View style={tagStyles.divider} />

          {/* Barcode */}
          <View style={tagStyles.barcodeBlock}>
            <FakeBarcode />
            <Text style={tagStyles.barcodeNum}>
              {item.id?.replace(/-/g, "").slice(0, 12).toUpperCase()}
            </Text>
          </View>
        </View>
      </Animated.View>
    </Modal>
  );
}

// ── Shared result card used by both RESULT and DETAIL screens ─────────────────
function ResultCard({ item, onExplore, onPrimary, primaryLabel, onBack, onDelete, pedalInputRef, onPedalKey }) {
  const displayValue = item.estimated_as_is_value?.toFixed(2);
  const [showTag, setShowTag] = useState(false);

  return (
    <SafeAreaView style={styles.resultContainer}>
      <StatusBar barStyle="light-content" backgroundColor={C.bg} />
      <GoodwillTagModal visible={showTag} item={item} onClose={() => setShowTag(false)} />

      {/* Back button */}
      {onBack && (
        <TouchableOpacity style={styles.resultBackBtn} onPress={onBack} activeOpacity={0.7}>
          <Text style={styles.resultBackText}>←</Text>
        </TouchableOpacity>
      )}

      {/* Delete button */}
      {onDelete && (
        <TouchableOpacity style={styles.resultDeleteBtn} onPress={onDelete} activeOpacity={0.7}>
          <Text style={styles.resultDeleteText}>🗑</Text>
        </TouchableOpacity>
      )}

      {/* Garment image */}
      {item.image_url && (
        <Image source={{ uri: item.image_url }} style={styles.resultImage} resizeMode="cover" />
      )}

      <View style={styles.resultContent}>
        {/* Brand + size row */}
        <View style={styles.resultBrandRow}>
          <Text style={styles.resultBrand}>{item.brand}</Text>
          {item.size && <Text style={styles.resultSize}>{item.size}</Text>}
        </View>

        {/* Model name */}
        <Text style={styles.resultModel}>{item.model_name}</Text>

        {/* Price block */}
        <View style={styles.resultPriceBlock}>
          <View style={styles.resultPriceItem}>
            <Text style={styles.resultPriceLabel}>AS-IS VALUE</Text>
            <Text style={styles.resultPriceValue}>
              ${displayValue}
            </Text>
          </View>
          {item.original_msrp > 0 && (
            <View style={[styles.resultPriceItem, styles.resultPriceItemRight]}>
              <Text style={styles.resultPriceLabel}>RETAIL</Text>
              <Text style={styles.resultPriceValueSub}>${item.original_msrp?.toFixed(2)}</Text>
            </View>
          )}
        </View>

        {/* Condition flags */}
        <View style={styles.flagsRow}>
          {(item.flags ?? []).length === 0 ? (
            <View style={[styles.flagBadge, styles.flagGood]}>
              <Text style={[styles.flagText, styles.flagGoodText]}>✓  Good Condition</Text>
            </View>
          ) : (
            (item.flags ?? []).map((flag) => (
              <View key={flag} style={[styles.flagBadge, flag === "damage" ? styles.flagDamage : styles.flagStain]}>
                <Text style={[styles.flagText, flag === "damage" ? styles.flagDamageText : styles.flagStainText]}>
                  {flag === "damage" ? "⚠  Damage Detected" : "◉  Stain Detected"}
                </Text>
              </View>
            ))
          )}
        </View>

        {/* Condition */}
        <View style={styles.resultConditionRow}>
          <Text style={styles.resultCondition}>{item.condition_assessment}</Text>
          {item.condition_rating != null && (
            <View style={styles.resultRatingBadge}>
              <Text style={styles.resultRatingText}>{item.condition_rating}<Text style={styles.resultRatingDenom}>/10</Text></Text>
            </View>
          )}
        </View>

        {/* Action buttons */}
        <View style={styles.resultActions}>
          {item.explore_url && (
            <TouchableOpacity
              style={styles.resultBtnSecondary}
              onPress={onExplore}
              activeOpacity={0.8}
            >
              <Text style={styles.resultBtnSecondaryText}>Explore Similar</Text>
            </TouchableOpacity>
          )}
          <TouchableOpacity style={styles.resultBtnPrimary} onPress={onPrimary} activeOpacity={0.8}>
            <Text style={styles.resultBtnPrimaryText}>{primaryLabel}</Text>
          </TouchableOpacity>
        </View>
        <TouchableOpacity style={styles.printTagBtn} onPress={() => setShowTag(true)} activeOpacity={0.85}>
          <Text style={styles.printTagBtnText}>Print Tag</Text>
        </TouchableOpacity>
      </View>
      {pedalInputRef && (
        <TextInput
          ref={pedalInputRef}
          style={styles.hiddenInput}
          value=""
          onChangeText={() => {}}
          onKeyPress={onPedalKey ?? (() => {})}
          showSoftInputOnFocus={false}
          blurOnSubmit={false}
          caretHidden
        />
      )}
    </SafeAreaView>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
export default function App() {
  const [screen, setScreen] = useState(S.HOME);
  const [capturedUris, setCapturedUris] = useState([null, null, null]);
  const [captureStep, _setCaptureStep] = useState(0); // 0=garment 1=tag 2=back
  const [capturePhase, _setCapturePhase] = useState('shooting'); // 'shooting'|'review'
  const [result, setResult] = useState(null);
  const [selectedItem, setSelectedItem] = useState(null);
  const [catalog, setCatalog] = useState([]);
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [zoomMode, setZoomMode] = useState('1x');
  const [burstMode, setBurstMode] = useState(false);
  const [burstCount, setBurstCount] = useState(0);
  const [burstResults, setBurstResults] = useState([]);

  const { hasPermission, requestPermission } = useCameraPermission();
  const devices = useCameraDevices();
  // Prefer the multi-lens back camera (virtual device that spans ultra-wide → tele)
  const backDevice = devices.find(d =>
    d.position === "back" &&
    d.physicalDevices?.includes("ultra-wide-angle-camera") &&
    d.physicalDevices?.includes("wide-angle-camera")
  ) ?? devices.find(d =>
    d.position === "back" && d.physicalDevices?.includes("wide-angle-camera")
  ) ?? devices.find(d => d.position === "back");
  // On multi-camera virtual devices, neutralZoom = standard (e.g. 2) and minZoom = ultra-wide (e.g. 1)
  const neutralZ = backDevice?.neutralZoom ?? 1;
  const minZ = backDevice?.minZoom ?? 1;
  const hasUltraWide = minZ < neutralZ;
  const zoomValue = zoomMode === '0.5x' ? minZ : zoomMode === '2x' ? neutralZ * 2 : neutralZ;
  const cameraRef = useRef(null);
  const pedalInputRef = useRef(null);
  const lastLeftPedalTime = useRef(0);
  const lastRightPedalTime = useRef(0);

  // Refs for stale-closure-safe access inside useCallback pedal handlers
  const captureStepRef = useRef(0);
  const capturePhaseRef = useRef('shooting');
  const capturedUrisRef = useRef([null, null, null]);
  capturedUrisRef.current = capturedUris; // sync every render
  const burstCountRef = useRef(0);
  burstCountRef.current = burstCount;
  const handleConfirmScanRef = useRef(null);

  // Per-thumbnail flash animations (pink overlay on capture)
  const thumbFlash = useRef([new Animated.Value(0), new Animated.Value(0), new Animated.Value(0)]).current;

  const setCaptureStep = useCallback((v) => { captureStepRef.current = v; _setCaptureStep(v); }, []);
  const setCapturePhase = useCallback((v) => { capturePhaseRef.current = v; _setCapturePhase(v); }, []);

  // Auto-focus hidden input on camera and result screens
  useEffect(() => {
    if ([S.CAPTURE, S.RESULT].includes(screen)) {
      setTimeout(() => pedalInputRef.current?.focus(), 300);
    }
  }, [screen, capturePhase]);

  const handleCapture = useCallback(async () => {
    if (capturePhaseRef.current !== 'shooting') return;
    if (!cameraRef.current) return;
    const photo = await cameraRef.current.takePhoto({ qualityPrioritization: "balanced", enableShutterSound: false });
    const uri = `file://${photo.path}`;
    const step = captureStepRef.current;
    setCapturedUris(prev => { const n = [...prev]; n[step] = uri; return n; });
    uploadPreviewPhoto(uri, STEP_KEYS[step]);
    // Flash the thumbnail pink to confirm capture
    thumbFlash[step].setValue(0);
    Animated.sequence([
      Animated.timing(thumbFlash[step], { toValue: 1, duration: 80, useNativeDriver: true }),
      Animated.timing(thumbFlash[step], { toValue: 0, duration: 400, useNativeDriver: true }),
    ]).start();
    if (step < 2) setCaptureStep(step + 1);
    else setCapturePhase('review');
  }, [setCaptureStep, setCapturePhase]);

  const handlePedalPress = useCallback(() => {
    const now = Date.now();
    if (now - lastLeftPedalTime.current < 1500) return;
    lastLeftPedalTime.current = now;

    if (screen === S.CAPTURE) {
      if (capturePhaseRef.current === 'shooting') handleCapture();
      else handleConfirmScanRef.current?.();
    } else if (screen === S.RESULT) {
      setResult(null);
      setCapturedUris([null, null, null]);
      setCaptureStep(0);
      setCapturePhase('shooting');
      setZoomMode('1x');
      setScreen(S.CAPTURE);
    }
  }, [screen, handleCapture, setCaptureStep, setCapturePhase]);

  const handleRetakePedal = useCallback(() => {
    const now = Date.now();
    if (now - lastRightPedalTime.current < 1500) return;
    lastRightPedalTime.current = now;
    if (screen === S.CAPTURE) {
      const step = captureStepRef.current;
      const phase = capturePhaseRef.current;
      if (phase === 'shooting' && step > 0) {
        // Jump back one step and immediately capture (one action)
        setCaptureStep(step - 1);
        handleCapture();
      } else if (phase === 'review') {
        // Retake last photo immediately
        setCaptureStep(2);
        setCapturePhase('shooting');
        handleCapture();
      }
    }
  }, [screen, handleCapture, setCaptureStep, setCapturePhase]);

  // Volume button also triggers pedal flow
  useEffect(() => {
    const isCapturing = screen === S.CAPTURE;
    VolumeManager.showNativeVolumeUI({ enabled: !isCapturing });
    const sub = VolumeManager.addVolumeListener(() => handlePedalPress());
    return () => {
      sub.remove();
      VolumeManager.showNativeVolumeUI({ enabled: true });
    };
  }, [screen, handlePedalPress]);

  const loadCatalog = useCallback(async () => {
    try {
      setCatalogLoading(true);
      const res = await fetch(CATALOG_ENDPOINT);
      const json = await res.json();
      setCatalog(json.items || []);
    } catch (e) {
      setCatalog([]);
    } finally {
      setCatalogLoading(false);
    }
  }, []);

  useEffect(() => {
    if (screen === S.HOME) loadCatalog();
  }, [screen]);

  const uploadPreviewPhoto = async (uri, step) => {
    try {
      const resized = await manipulateAsync(
        uri,
        [{ resize: { width: 400 } }],
        { compress: 0.6, format: SaveFormat.JPEG, base64: true }
      );
      await fetch(`${RTDB_URL}/preview/current.json`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ step, thumbnail: resized.base64, updated_at: new Date().toISOString() }),
      });
    } catch (e) {}
  };

  const handleRetake = (step) => {
    setCapturedUris(prev => { const n = [...prev]; n[step] = null; return n; });
    setCaptureStep(step);
    setCapturePhase('shooting');
  };

  const handleConfirmScan = () => {
    const uris = capturedUrisRef.current;
    fetch(`${RTDB_URL}/preview/current.json`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ step: "completed", thumbnail: null, updated_at: new Date().toISOString() }),
    }).catch(() => {});
    if (burstMode) {
      const idx = burstCountRef.current;
      const newCount = idx + 1;
      burstCountRef.current = newCount;
      setBurstCount(newCount);
      setBurstResults(prev => [...prev, { index: idx, status: 'loading', data: null, error: null }]);
      runScan(uris[0], uris[1], uris[2], 'gemini-2.5-pro').then(data => {
        setBurstResults(prev => prev.map(r => r.index === idx ? { ...r, status: 'done', data } : r));
      }).catch(err => {
        setBurstResults(prev => prev.map(r => r.index === idx ? { ...r, status: 'error', error: err.message ?? 'Scan failed' } : r));
      });
      if (newCount < 10) {
        setCapturedUris([null, null, null]);
        setCaptureStep(0);
        setCapturePhase('shooting');
      } else {
        setScreen(S.BURST_RESULTS);
      }
    } else {
      setScreen(S.LOADING);
      submitScan(uris[0], uris[1], uris[2]);
    }
  };
  handleConfirmScanRef.current = handleConfirmScan;

  const handleCancelScan = () => {
    setCapturedUris([null, null, null]);
    setCaptureStep(0);
    setCapturePhase('shooting');
    if (burstMode) {
      setBurstCount(0);
      burstCountRef.current = 0;
      setBurstResults([]);
    }
    setScreen(S.HOME);
  };

  const runScan = async (jacketUri, brandTagUri, backUri, model = null) => {
    const body = new FormData();
    if (jacketUri) body.append("jacket_image", { uri: jacketUri, name: "jacket.jpg", type: "image/jpeg" });
    if (brandTagUri) body.append("tag_image", { uri: brandTagUri, name: "tag.jpg", type: "image/jpeg" });
    if (backUri) body.append("back_image", { uri: backUri, name: "back.jpg", type: "image/jpeg" });
    const url = model ? `${SCAN_ENDPOINT}?model=${encodeURIComponent(model)}` : SCAN_ENDPOINT;
    const response = await fetchWithTimeout(
      url,
      { method: "POST", body, headers: { "Content-Type": "multipart/form-data" } },
      REQUEST_TIMEOUT_MS
    );
    if (!response.ok) throw new Error(`Server ${response.status}: ${await response.text()}`);
    const json = await response.json();
    return json.data;
  };

  const submitScan = async (jacketUri, brandTagUri, backUri) => {
    try {
      const data = await runScan(jacketUri, brandTagUri, backUri);
      setResult(data);
      setScreen(S.RESULT);
    } catch (err) {
      const msg = err.name === "AbortError"
        ? "Request timed out. Check your connection and try again."
        : err.message ?? "Unknown error.";
      Alert.alert("Scan Failed", msg, [{ text: "Retry", onPress: () => setScreen(S.CAPTURE) }]);
      setScreen(S.HOME);
    }
  };

  const resetToHome = () => {
    setCapturedUris([null, null, null]);
    setCaptureStep(0);
    setCapturePhase('shooting');
    setResult(null);
    setZoomMode('1x');
    setScreen(S.HOME);
  };

  // ── Permission gate ───────────────────────────────────────────────────────
  if (screen === S.CAPTURE && !hasPermission) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.centered}>
          <Text style={styles.permissionText}>Camera access is required.</Text>
          <TouchableOpacity style={styles.primaryBtn} onPress={requestPermission}>
            <Text style={styles.primaryBtnText}>GRANT ACCESS</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  // ══════════════════════════════════════════════════════════════════════════
  // HOME
  // ══════════════════════════════════════════════════════════════════════════
  if (screen === S.HOME) {
    return (
      <SafeAreaView style={styles.container}>
        <StatusBar barStyle="light-content" backgroundColor={C.bg} />
        <View style={styles.homeHeader}>
          <View>
            <Text style={styles.homeTitle}>Scanner</Text>
            <Text style={styles.homeSubtitle}>{catalog.length} items scanned</Text>
          </View>
          <View style={styles.homeHeaderActions}>
            <TouchableOpacity
              style={styles.analyticsBtn}
              onPress={() => setScreen(S.ANALYTICS)}
              activeOpacity={0.8}
            >
              <Text style={styles.analyticsBtnText}>Analytics</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.newScanBtn}
              onPress={() => {
                if (!hasPermission) { requestPermission(); return; }
                if (burstMode) { setBurstCount(0); burstCountRef.current = 0; setBurstResults([]); }
                setScreen(S.CAPTURE);
              }}
              activeOpacity={0.8}
            >
              <Text style={styles.newScanBtnText}>+ NEW SCAN</Text>
            </TouchableOpacity>
          </View>
        </View>

        <View style={styles.modeSwitchRow}>
          <TouchableOpacity style={[styles.modeBtn, !burstMode && styles.modeBtnActive]} onPress={() => setBurstMode(false)} activeOpacity={0.8}>
            <Text style={[styles.modeBtnText, !burstMode && styles.modeBtnTextActive]}>Standard</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[styles.modeBtn, burstMode && styles.modeBtnActive]} onPress={() => setBurstMode(true)} activeOpacity={0.8}>
            <Text style={[styles.modeBtnText, burstMode && styles.modeBtnTextActive]}>Burst</Text>
          </TouchableOpacity>
        </View>

        {catalogLoading ? (
          <View style={styles.centered}>
            <ActivityIndicator size="large" color={C.accent} />
          </View>
        ) : catalog.length === 0 ? (
          <View style={styles.centered}>
            <Text style={styles.emptyText}>No scans yet.</Text>
            <Text style={styles.emptySubtext}>Tap + NEW SCAN to get started.</Text>
          </View>
        ) : (
          <FlatList
            data={catalog}
            keyExtractor={(item) => item.id}
            contentContainerStyle={styles.catalogList}
            numColumns={2}
            columnWrapperStyle={styles.catalogRow}
            renderItem={({ item }) => (
              <TouchableOpacity
                style={styles.catalogCard}
                onPress={() => { setSelectedItem(item); setScreen(S.DETAIL); }}
                activeOpacity={0.85}
              >
                {item.image_url ? (
                  <Image source={{ uri: item.image_url }} style={styles.catalogThumb} resizeMode="cover" />
                ) : (
                  <View style={[styles.catalogThumb, styles.catalogThumbEmpty]} />
                )}
                <View style={styles.catalogCardBody}>
                  <Text style={styles.catalogCardBrand} numberOfLines={1}>{item.brand}</Text>
                  <Text style={styles.catalogCardModel} numberOfLines={2}>{item.model_name}</Text>
                  <View style={styles.catalogCardFooter}>
                    <Text style={styles.catalogCardPrice}>${item.estimated_as_is_value?.toFixed(0)}</Text>
                  </View>
                </View>
              </TouchableOpacity>
            )}
          />
        )}
      </SafeAreaView>
    );
  }

  // ══════════════════════════════════════════════════════════════════════════
  // ANALYTICS
  // ══════════════════════════════════════════════════════════════════════════
  if (screen === S.ANALYTICS) {
    const totalValue = catalog.reduce((s, i) => s + (parseFloat(i.estimated_as_is_value) || 0), 0);
    const avgValue = catalog.length ? totalValue / catalog.length : 0;
    const categoryMap = {};
    catalog.forEach((i) => {
      const cat = i.category || "Uncategorized";
      categoryMap[cat] = (categoryMap[cat] || 0) + 1;
    });
    const categorySorted = Object.entries(categoryMap).sort((a, b) => b[1] - a[1]);

    return (
      <SafeAreaView style={styles.container}>
        <StatusBar barStyle="light-content" backgroundColor={C.bg} />
        <View style={styles.analyticsHeader}>
          <TouchableOpacity onPress={() => setScreen(S.HOME)} activeOpacity={0.7} style={{ padding: 4 }}>
            <Text style={styles.analyticsBack}>←</Text>
          </TouchableOpacity>
          <Text style={styles.analyticsTitle}>Analytics</Text>
          <View style={{ width: 32 }} />
        </View>

        <ScrollView contentContainerStyle={styles.analyticsList}>
          <View style={styles.statsRow}>
            <View style={styles.statCard}>
              <Text style={styles.statValue}>{catalog.length}</Text>
              <Text style={styles.statLabel}>ITEMS SCANNED</Text>
            </View>
            <View style={styles.statCard}>
              <Text style={styles.statValue}>${totalValue.toFixed(0)}</Text>
              <Text style={styles.statLabel}>TOTAL VALUE</Text>
            </View>
            <View style={styles.statCard}>
              <Text style={styles.statValue}>${avgValue.toFixed(2)}</Text>
              <Text style={styles.statLabel}>AVG PER ITEM</Text>
            </View>
          </View>

          <Text style={styles.analyticsSectionHeader}>BY CATEGORY</Text>

          {categorySorted.map(([cat, count]) => (
            <View key={cat} style={styles.categoryRow}>
              <View style={[styles.categoryDot, { backgroundColor: tagHeaderColor(cat) }]} />
              <Text style={styles.categoryRowName}>{cat}</Text>
              <Text style={styles.categoryRowCount}>{count}</Text>
            </View>
          ))}

          <TouchableOpacity
            style={styles.exportBtn}
            onPress={() => Linking.openURL(EXPORT_URL)}
            activeOpacity={0.85}
          >
            <Text style={styles.exportBtnText}>Export CSV</Text>
          </TouchableOpacity>
        </ScrollView>
      </SafeAreaView>
    );
  }

  // ══════════════════════════════════════════════════════════════════════════
  // DETAIL
  // ══════════════════════════════════════════════════════════════════════════
  if (screen === S.DETAIL && selectedItem) {
    const handleDelete = () => {
      Alert.alert(
        "Delete Item",
        "Remove this item from the catalog?",
        [
          { text: "Cancel", style: "cancel" },
          {
            text: "Delete",
            style: "destructive",
            onPress: async () => {
              try {
                await fetch(`${API_BASE_URL}/api/v1/scans/${selectedItem.id}`, { method: "DELETE" });
              } catch (e) {
                // non-fatal — remove from local state regardless
              }
              setSelectedItem(null);
              setScreen(S.HOME);
            },
          },
        ]
      );
    };
    return (
      <ResultCard
        item={selectedItem}
        onBack={() => setScreen(S.HOME)}
        onExplore={() => Linking.openURL(selectedItem.explore_url)}
        onDelete={handleDelete}
        onPrimary={() => {
          if (!hasPermission) { requestPermission(); return; }
          setSelectedItem(null);
          setScreen(S.CAPTURE);
        }}
        primaryLabel="New Scan"
      />
    );
  }

  // ══════════════════════════════════════════════════════════════════════════
  // RESULT
  // ══════════════════════════════════════════════════════════════════════════
  if (screen === S.RESULT && result) {
    return (
      <ResultCard
        item={result}
        onBack={resetToHome}
        onExplore={() => Linking.openURL(result.explore_url)}
        onPrimary={() => {
          setResult(null);
          setCapturedUris([null, null, null]);
          setCaptureStep(0);
          setCapturePhase('shooting');
          setZoomMode('1x');
          setScreen(S.CAPTURE);
        }}
        primaryLabel="Scan Next"
        pedalInputRef={pedalInputRef}
        onPedalKey={({ nativeEvent }) => {
          if (nativeEvent.key === " ") handlePedalPress();
        }}
      />
    );
  }

  // ══════════════════════════════════════════════════════════════════════════
  // LOADING
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
  // CAPTURE
  // ══════════════════════════════════════════════════════════════════════════
  if (screen === S.CAPTURE) {
    if (!backDevice) {
      return <View style={styles.centered}><ActivityIndicator size="large" color={C.accent} /></View>;
    }

    return (
      <View style={styles.cameraWrapper}>
        <StatusBar barStyle="light-content" backgroundColor="transparent" translucent />
        {/* Camera stays mounted throughout so pedal retake works instantly */}
        <Camera ref={cameraRef} style={StyleSheet.absoluteFill} device={backDevice} isActive photo zoom={zoomValue} />

        {capturePhase === 'review' ? (
          /* ── Review overlay: expanded photos fill the screen ── */
          <View style={[StyleSheet.absoluteFill, { backgroundColor: '#000' }]}>
            <SafeAreaView style={{ flex: 1 }}>
              <View style={styles.reviewHeader}>
                <Text style={styles.reviewLabel}>REVIEW  ·  Tap to retake</Text>
              </View>
              <View style={styles.reviewRow}>
                {[0, 1, 2].map(i => (
                  <TouchableOpacity
                    key={i}
                    style={[styles.reviewPanel, i === 1 && styles.reviewPanelTag]}
                    onPress={() => {
                      setCapturedUris(prev => { const n = [...prev]; n[i] = null; return n; });
                      setCaptureStep(i);
                      setCapturePhase('shooting');
                    }}
                    activeOpacity={0.85}
                  >
                    {capturedUris[i] ? (
                      <Image source={{ uri: capturedUris[i] }} style={styles.reviewImg} resizeMode="cover" />
                    ) : (
                      <View style={{ flex: 1, backgroundColor: '#0f0f1e' }} />
                    )}
                    <View style={styles.reviewPanelFooter}>
                      <Text style={styles.reviewPanelFooterText}>{['GARMENT', 'TAG', 'BACK'][i]}</Text>
                    </View>
                  </TouchableOpacity>
                ))}
              </View>
              <View style={styles.reviewControls}>
                <TouchableOpacity style={styles.cancelScanBtn} onPress={handleCancelScan} activeOpacity={0.8}>
                  <Text style={styles.cancelScanBtnText}>✕</Text>
                </TouchableOpacity>
                <View style={styles.shutterPlaceholder} />
                <TouchableOpacity style={styles.confirmScanBtn} onPress={handleConfirmScan} activeOpacity={0.8}>
                  <Text style={styles.confirmScanBtnText}>✓</Text>
                </TouchableOpacity>
              </View>
            </SafeAreaView>
          </View>
        ) : (
          /* ── Shooting UI ── */
          <>
            <SafeAreaView style={styles.capOverlayTop}>
              <View style={styles.capThumbRow}>
                {[0, 1, 2].map(i => {
                  const isActive = captureStep === i;
                  const isCaptured = !!capturedUris[i];
                  return (
                    <TouchableOpacity
                      key={i}
                      style={[styles.capThumb, isActive && styles.capThumbActive, isCaptured && !isActive && styles.capThumbDone]}
                      onPress={() => {
                        setCapturedUris(prev => { const n = [...prev]; n[i] = null; return n; });
                        setCaptureStep(i);
                      }}
                      activeOpacity={0.75}
                    >
                      {isCaptured ? (
                        <Image source={{ uri: capturedUris[i] }} style={styles.capThumbImg} resizeMode="cover" />
                      ) : (
                        <View style={styles.capThumbEmpty}>
                          <Text style={[styles.capThumbNum, isActive && styles.capThumbNumActive]}>{i + 1}</Text>
                        </View>
                      )}
                      <Animated.View style={[styles.capThumbFlash, { opacity: thumbFlash[i] }]} />
                    </TouchableOpacity>
                  );
                })}
              </View>
              <View style={styles.capStepLabelRow}>
                {burstMode && (
                  <View style={styles.burstBadge}>
                    <Text style={styles.burstBadgeText}>BURST  {burstCount + 1}/10</Text>
                  </View>
                )}
                <Text style={styles.capStepLabel}>{captureStep + 1} / 3  ·  {STEP_LABELS[captureStep]}</Text>
              </View>
            </SafeAreaView>

            <View style={styles.cameraFooter}>
              <View style={styles.zoomRow}>
                {hasUltraWide && (
                  <TouchableOpacity
                    style={[styles.zoomBtn, zoomMode === '0.5x' && styles.zoomBtnActive]}
                    onPress={() => setZoomMode('0.5x')}
                    activeOpacity={0.8}
                  >
                    <Text style={[styles.zoomBtnText, zoomMode === '0.5x' && styles.zoomBtnTextActive]}>0.5×</Text>
                  </TouchableOpacity>
                )}
                <TouchableOpacity
                  style={[styles.zoomBtn, zoomMode === '1x' && styles.zoomBtnActive]}
                  onPress={() => setZoomMode('1x')}
                  activeOpacity={0.8}
                >
                  <Text style={[styles.zoomBtnText, zoomMode === '1x' && styles.zoomBtnTextActive]}>1×</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.zoomBtn, zoomMode === '2x' && styles.zoomBtnActive]}
                  onPress={() => setZoomMode('2x')}
                  activeOpacity={0.8}
                >
                  <Text style={[styles.zoomBtnText, zoomMode === '2x' && styles.zoomBtnTextActive]}>2×</Text>
                </TouchableOpacity>
              </View>
              <View style={styles.captureControlRow}>
                <TouchableOpacity style={styles.cancelScanBtn} onPress={handleCancelScan} activeOpacity={0.8}>
                  <Text style={styles.cancelScanBtnText}>✕</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.shutterRing} onPress={handleCapture} activeOpacity={0.85}>
                  <View style={styles.shutterDisc} />
                </TouchableOpacity>
                <TouchableOpacity style={styles.confirmScanBtn} onPress={handleConfirmScan} activeOpacity={0.8}>
                  <Text style={styles.confirmScanBtnText}>✓</Text>
                </TouchableOpacity>
              </View>
            </View>
          </>
        )}

        {/* Hidden input for Bluetooth pedal (Space = left, Enter = right) */}
        <TextInput
          ref={pedalInputRef}
          style={styles.hiddenInput}
          value=""
          onChangeText={() => {}}
          onKeyPress={({ nativeEvent }) => {
            if (nativeEvent.key === " ") handlePedalPress();
          }}
          onSubmitEditing={handleRetakePedal}
          showSoftInputOnFocus={false}
          blurOnSubmit={false}
          caretHidden
        />
      </View>
    );
  }

  // ══════════════════════════════════════════════════════════════════════════
  // BURST RESULTS
  // ══════════════════════════════════════════════════════════════════════════
  if (screen === S.BURST_RESULTS) {
    const doneCount = burstResults.filter(r => r.status !== 'loading').length;
    const allDone = burstResults.length > 0 && doneCount === burstResults.length;

    const exitBurst = () => {
      setBurstCount(0);
      burstCountRef.current = 0;
      setBurstResults([]);
      setBurstMode(false);
      setScreen(S.HOME);
    };

    return (
      <SafeAreaView style={styles.container}>
        <StatusBar barStyle="light-content" backgroundColor={C.bg} />
        <View style={styles.burstHeader}>
          <TouchableOpacity onPress={exitBurst} activeOpacity={0.7}>
            <Text style={styles.burstBackText}>← Exit</Text>
          </TouchableOpacity>
          <Text style={styles.burstTitle}>Burst  {doneCount}/{burstResults.length}</Text>
          <View style={{ width: 60 }} />
        </View>

        <FlatList
          data={burstResults}
          keyExtractor={(item) => String(item.index)}
          numColumns={2}
          columnWrapperStyle={styles.catalogRow}
          contentContainerStyle={[styles.catalogList, { paddingBottom: allDone ? 120 : 40 }]}
          renderItem={({ item: r }) => (
            <View style={styles.catalogCard}>
              {r.status === 'loading' ? (
                <View style={[styles.catalogThumb, styles.catalogThumbEmpty, styles.burstCardCenter]}>
                  <ActivityIndicator color={C.accent} />
                </View>
              ) : r.status === 'error' ? (
                <View style={[styles.catalogThumb, styles.catalogThumbEmpty, styles.burstCardCenter]}>
                  <Text style={styles.burstErrorIcon}>✕</Text>
                </View>
              ) : r.data?.image_url ? (
                <Image source={{ uri: r.data.image_url }} style={styles.catalogThumb} resizeMode="cover" />
              ) : (
                <View style={[styles.catalogThumb, styles.catalogThumbEmpty]} />
              )}
              <View style={styles.catalogCardBody}>
                {r.status === 'loading' ? (
                  <Text style={styles.catalogCardBrand}>SCANNING…</Text>
                ) : r.status === 'error' ? (
                  <Text style={[styles.catalogCardBrand, { color: '#DC2626' }]}>FAILED</Text>
                ) : (
                  <>
                    <Text style={styles.catalogCardBrand} numberOfLines={1}>{r.data.brand}</Text>
                    <Text style={styles.catalogCardModel} numberOfLines={2}>{r.data.model_name}</Text>
                    <View style={styles.catalogCardFooter}>
                      <Text style={styles.catalogCardPrice}>${r.data.estimated_as_is_value?.toFixed(0)}</Text>
                    </View>
                  </>
                )}
              </View>
            </View>
          )}
        />

        {allDone && (
          <View style={styles.burstDoneBar}>
            <TouchableOpacity
              style={styles.burstDoneBtn}
              onPress={() => { setBurstCount(0); burstCountRef.current = 0; setBurstResults([]); setScreen(S.HOME); }}
              activeOpacity={0.8}
            >
              <Text style={styles.burstDoneBtnText}>Done — View Catalog</Text>
            </TouchableOpacity>
          </View>
        )}
      </SafeAreaView>
    );
  }

  return null;
}

// ── Styles ────────────────────────────────────────────────────────────────────
const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: C.bg },
  centered: { flex: 1, justifyContent: "center", alignItems: "center", padding: 40 },
  permissionText: { fontSize: 20, color: C.textPrimary, textAlign: "center", marginBottom: 28 },
  primaryBtn: { backgroundColor: C.accent, borderRadius: 14, paddingVertical: 16, paddingHorizontal: 36 },
  primaryBtnText: { fontSize: 16, color: C.white, fontWeight: "800", letterSpacing: 2 },

  // ── Home ──────────────────────────────────────────────────────────────────
  homeHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingHorizontal: 24, paddingTop: 8, paddingBottom: 20 },
  homeHeaderActions: { flexDirection: "row", gap: 8, alignItems: "center" },
  homeTitle: { fontSize: 30, fontWeight: "900", color: C.white, letterSpacing: 0.5 },
  homeSubtitle: { fontSize: 13, color: C.textMuted, marginTop: 2 },
  analyticsBtn: { borderWidth: 1, borderColor: C.cardBorder, borderRadius: 12, paddingVertical: 10, paddingHorizontal: 14 },
  analyticsBtnText: { fontSize: 13, fontWeight: "700", color: C.textSub, letterSpacing: 0.5 },
  newScanBtn: { backgroundColor: C.accent, borderRadius: 12, paddingVertical: 10, paddingHorizontal: 16 },
  newScanBtnText: { fontSize: 13, fontWeight: "800", color: C.white, letterSpacing: 1.5 },
  emptyText: { fontSize: 20, color: C.textPrimary, fontWeight: "700", marginBottom: 8 },
  emptySubtext: { fontSize: 15, color: C.textMuted },

  // ── Analytics ─────────────────────────────────────────────────────────────
  analyticsHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 20, paddingTop: 8, paddingBottom: 16 },
  analyticsBack: { fontSize: 22, color: C.textSub, fontWeight: "300" },
  analyticsTitle: { fontSize: 20, fontWeight: "900", color: C.white, letterSpacing: 0.5 },
  analyticsList: { paddingHorizontal: 20, paddingBottom: 40 },
  statsRow: { flexDirection: "row", gap: 10, marginBottom: 28 },
  statCard: { flex: 1, backgroundColor: C.card, borderRadius: 14, borderWidth: 1, borderColor: C.cardBorder, padding: 14, alignItems: "center" },
  statValue: { fontSize: 22, fontWeight: "900", color: C.white, marginBottom: 4 },
  statLabel: { fontSize: 9, fontWeight: "700", color: C.textMuted, letterSpacing: 1.5, textAlign: "center" },
  analyticsSectionHeader: { fontSize: 11, fontWeight: "700", color: C.textMuted, letterSpacing: 3, marginBottom: 12 },
  categoryRow: { flexDirection: "row", alignItems: "center", paddingVertical: 13, borderBottomWidth: 1, borderBottomColor: C.cardBorder, gap: 12 },
  categoryDot: { width: 10, height: 10, borderRadius: 5 },
  categoryRowName: { flex: 1, fontSize: 14, color: C.textPrimary, fontWeight: "600" },
  categoryRowCount: { fontSize: 16, fontWeight: "900", color: C.white },
  exportBtn: { marginTop: 32, backgroundColor: C.card, borderWidth: 1, borderColor: C.cardBorder, borderRadius: 12, paddingVertical: 16, alignItems: "center" },
  exportBtnText: { fontSize: 14, fontWeight: "700", color: C.textSub, letterSpacing: 1 },

  // ── Catalog grid ──────────────────────────────────────────────────────────
  catalogList: { paddingHorizontal: 16, paddingBottom: 32 },
  catalogRow: { gap: 10, marginBottom: 10 },
  catalogCard: { flex: 1, backgroundColor: C.card, borderRadius: 14, overflow: "hidden", borderWidth: 1, borderColor: C.cardBorder },
  catalogThumb: { width: "100%", aspectRatio: 1 },
  catalogThumbEmpty: { backgroundColor: "#0f0f1e" },
  catalogCardBody: { padding: 10 },
  catalogCardBrand: { fontSize: 10, color: C.textMuted, fontWeight: "700", letterSpacing: 2, textTransform: "uppercase", marginBottom: 3 },
  catalogCardModel: { fontSize: 13, color: C.textPrimary, fontWeight: "700", lineHeight: 18 },
  catalogCardFooter: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: 8 },
  catalogCardPrice: { fontSize: 15, color: C.white, fontWeight: "900" },

  // ── Result / Detail ───────────────────────────────────────────────────────
  resultContainer: { flex: 1, backgroundColor: C.bg },
  resultBackBtn: { position: "absolute", top: 56, left: 20, zIndex: 10, padding: 8 },
  resultBackText: { fontSize: 22, color: C.textSub, fontWeight: "300" },
  resultDeleteBtn: { position: "absolute", top: 56, right: 20, zIndex: 10, padding: 8 },
  resultDeleteText: { fontSize: 20 },
  resultImage: { width: "100%", height: 260 },
  resultContent: { flex: 1, paddingHorizontal: 24, paddingTop: 20, paddingBottom: 32 },
  resultBrandRow: { flexDirection: "row", alignItems: "center", gap: 10, marginBottom: 4 },
  resultBrand: { fontSize: 12, color: C.textMuted, fontWeight: "700", letterSpacing: 3, textTransform: "uppercase" },
  resultSize: { fontSize: 12, color: C.textMuted, fontWeight: "600", backgroundColor: C.card, paddingHorizontal: 8, paddingVertical: 2, borderRadius: 6, borderWidth: 1, borderColor: C.cardBorder },
  resultModel: { fontSize: 28, fontWeight: "900", color: C.white, lineHeight: 34, marginBottom: 14 },
  resultBadge: { alignSelf: "flex-start", paddingVertical: 5, paddingHorizontal: 12, borderRadius: 20, borderWidth: 1, marginBottom: 20 },
  resultBadgeText: { fontSize: 11, fontWeight: "800", letterSpacing: 2 },
  resultPriceBlock: { flexDirection: "row", alignItems: "flex-end", gap: 24, marginBottom: 16 },
  resultPriceItem: {},
  resultPriceItemRight: { borderLeftWidth: 1, borderLeftColor: C.cardBorder, paddingLeft: 24 },
  resultPriceLabel: { fontSize: 11, color: C.textMuted, fontWeight: "700", letterSpacing: 3, marginBottom: 2 },
  resultPriceValue: { fontSize: 52, fontWeight: "900", letterSpacing: -1, color: C.accent },
  resultPriceValueSub: { fontSize: 28, fontWeight: "700", color: C.textSub },
  flagsRow: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginBottom: 14 },
  flagBadge: { paddingVertical: 6, paddingHorizontal: 14, borderRadius: 20, borderWidth: 1 },
  flagGood: { backgroundColor: "rgba(22,163,74,0.15)", borderColor: "#16A34A" },
  flagGoodText: { color: "#16A34A" },
  flagDamage: { backgroundColor: "rgba(220,38,38,0.15)", borderColor: "#DC2626" },
  flagDamageText: { color: "#DC2626" },
  flagStain: { backgroundColor: "rgba(202,138,4,0.15)", borderColor: "#CA8A04" },
  flagStainText: { color: "#EAB308" },
  flagText: { fontSize: 12, fontWeight: "800", letterSpacing: 1 },
  resultConditionRow: { flexDirection: "row", alignItems: "flex-start", gap: 12, marginBottom: 28 },
  resultCondition: { flex: 1, fontSize: 14, color: C.textSub, lineHeight: 22 },
  resultRatingBadge: { backgroundColor: C.card, borderWidth: 1, borderColor: C.cardBorder, borderRadius: 10, paddingVertical: 4, paddingHorizontal: 10, alignItems: "center" },
  resultRatingText: { fontSize: 16, fontWeight: "900", color: C.white },
  resultRatingDenom: { fontSize: 11, fontWeight: "500", color: C.textMuted },
  resultActions: { flexDirection: "row", gap: 10, marginTop: "auto" },
  resultBtnSecondary: { flex: 1, borderWidth: 1, borderColor: C.cardBorder, borderRadius: 12, paddingVertical: 14, alignItems: "center" },
  resultBtnSecondaryText: { fontSize: 13, fontWeight: "700", color: C.textSub, letterSpacing: 1 },
  resultBtnPrimary: { flex: 1, backgroundColor: C.accent, borderRadius: 12, paddingVertical: 14, alignItems: "center" },
  resultBtnPrimaryText: { fontSize: 13, fontWeight: "800", color: C.white, letterSpacing: 1 },
  printTagBtn: { marginTop: 10, backgroundColor: "#F5C800", borderRadius: 12, paddingVertical: 16, alignItems: "center" },
  printTagBtnText: { fontSize: 15, fontWeight: "900", color: "#111", letterSpacing: 1.5 },

  // ── Loading ───────────────────────────────────────────────────────────────
  loadingScreen: { flex: 1, backgroundColor: C.bg, justifyContent: "center", alignItems: "center", gap: 20 },
  loadingHeadline: { fontSize: 26, color: C.white, fontWeight: "800" },
  loadingSubtext: { fontSize: 16, color: C.textMuted },

  // ── Camera / Capture ──────────────────────────────────────────────────────
  cameraWrapper: { flex: 1, backgroundColor: "#000" },
  cameraFooter: { position: "absolute", bottom: 44, left: 0, right: 0, alignItems: "center", gap: 16 },
  zoomRow: { flexDirection: "row", gap: 10 },
  zoomBtn: { paddingVertical: 6, paddingHorizontal: 16, borderRadius: 20, backgroundColor: "rgba(0,0,0,0.45)", borderWidth: 1, borderColor: "rgba(255,255,255,0.25)" },
  zoomBtnActive: { backgroundColor: C.white },
  zoomBtnText: { fontSize: 13, fontWeight: "700", color: C.white, letterSpacing: 1 },
  zoomBtnTextActive: { color: C.bg },
  shutterRing: { width: 78, height: 78, borderRadius: 39, borderWidth: 4, borderColor: C.white, backgroundColor: "rgba(255,255,255,0.12)", justifyContent: "center", alignItems: "center" },
  shutterDisc: { width: 60, height: 60, borderRadius: 30, backgroundColor: C.white },
  hiddenInput: { position: "absolute", width: 1, height: 1, opacity: 0 },

  // ── Capture thumbnail strip ───────────────────────────────────────────────
  capOverlayTop: { position: "absolute", top: 0, left: 0, right: 0, paddingBottom: 12 },
  capThumbRow: { flexDirection: "row", gap: 10, paddingHorizontal: 20, paddingTop: 10, justifyContent: "center" },
  capThumb: { width: 80, height: 80, borderRadius: 10, borderWidth: 2, borderColor: "rgba(255,255,255,0.18)", overflow: "hidden" },
  capThumbActive: { borderColor: C.accent, borderWidth: 2.5 },
  capThumbDone: { borderColor: "rgba(255,255,255,0.5)" },
  capThumbImg: { width: "100%", height: "100%" },
  capThumbFlash: { ...StyleSheet.absoluteFillObject, backgroundColor: C.accent, borderRadius: 8 },
  capThumbEmpty: { flex: 1, justifyContent: "center", alignItems: "center", backgroundColor: "rgba(255,255,255,0.06)" },
  capThumbNum: { fontSize: 22, fontWeight: "700", color: "rgba(255,255,255,0.25)" },
  capThumbNumActive: { color: C.accent },
  capStepLabelRow: { alignItems: "center", paddingTop: 8 },
  capStepLabel: { fontSize: 13, fontWeight: "700", color: C.white, letterSpacing: 0.5 },

  // ── Review ────────────────────────────────────────────────────────────────
  reviewHeader: { alignItems: 'center', paddingVertical: 14 },
  reviewLabel: { fontSize: 13, fontWeight: '700', color: 'rgba(255,255,255,0.6)', letterSpacing: 1 },
  reviewRow: { flex: 1, flexDirection: 'row', paddingHorizontal: 16, gap: 10 },
  reviewPanel: { flex: 3, borderRadius: 14, overflow: 'hidden', backgroundColor: '#111' },
  reviewPanelTag: { flex: 4 },
  reviewImg: { flex: 1, width: '100%' },
  reviewPanelFooter: { backgroundColor: 'rgba(0,0,0,0.65)', paddingVertical: 8, alignItems: 'center' },
  reviewPanelFooterText: { fontSize: 9, fontWeight: '800', color: 'rgba(255,255,255,0.65)', letterSpacing: 2 },
  reviewControls: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 36, paddingVertical: 24, paddingBottom: 36 },

  // ── Mode switch ───────────────────────────────────────────────────────────
  modeSwitchRow: { flexDirection: "row", marginHorizontal: 24, marginBottom: 16, backgroundColor: C.card, borderRadius: 12, padding: 4, borderWidth: 1, borderColor: C.cardBorder },
  modeBtn: { flex: 1, paddingVertical: 8, borderRadius: 9, alignItems: "center" },
  modeBtnActive: { backgroundColor: C.accent },
  modeBtnText: { fontSize: 13, fontWeight: "700", color: C.textMuted, letterSpacing: 0.5 },
  modeBtnTextActive: { color: C.white },

  // ── Burst ─────────────────────────────────────────────────────────────────
  burstBadge: { backgroundColor: C.accentSoft, borderWidth: 1, borderColor: C.accent, borderRadius: 20, paddingVertical: 4, paddingHorizontal: 14, marginBottom: 6 },
  burstBadgeText: { fontSize: 11, fontWeight: "800", color: C.accent, letterSpacing: 2 },
  burstHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 20, paddingTop: 8, paddingBottom: 16 },
  burstBackText: { fontSize: 15, color: C.textSub, fontWeight: "600" },
  burstTitle: { fontSize: 20, fontWeight: "900", color: C.white },
  burstCardCenter: { justifyContent: "center", alignItems: "center" },
  burstErrorIcon: { fontSize: 22, color: "#DC2626" },
  burstDoneBar: { position: "absolute", bottom: 0, left: 0, right: 0, paddingHorizontal: 24, paddingBottom: 44, paddingTop: 16, backgroundColor: C.bg, borderTopWidth: 1, borderTopColor: C.cardBorder },
  burstDoneBtn: { backgroundColor: C.accent, borderRadius: 14, paddingVertical: 16, alignItems: "center" },
  burstDoneBtnText: { fontSize: 15, fontWeight: "800", color: C.white, letterSpacing: 1 },

  // ── Capture control row (cancel | shutter | confirm) ─────────────────────
  captureControlRow: { flexDirection: "row", alignItems: "center", gap: 36 },
  shutterPlaceholder: { width: 78, height: 78 },
  cancelScanBtn: { width: 48, height: 48, borderRadius: 24, borderWidth: 2, borderColor: "rgba(255,255,255,0.7)", justifyContent: "center", alignItems: "center" },
  cancelScanBtnText: { fontSize: 18, color: C.white, fontWeight: "600" },
  confirmScanBtn: { width: 48, height: 48, borderRadius: 24, borderWidth: 2, borderColor: C.accent, justifyContent: "center", alignItems: "center" },
  confirmScanBtnText: { fontSize: 22, color: C.accent, fontWeight: "700" },
});

// ── Goodwill Tag Styles ───────────────────────────────────────────────────────
const tagStyles = StyleSheet.create({
  backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: "#000" },
  wrapper: { flex: 1, justifyContent: "center", alignItems: "center", paddingHorizontal: 40 },
  card: { backgroundColor: "#fff", borderRadius: 6, width: "100%", overflow: "hidden", shadowColor: "#000", shadowOpacity: 0.4, shadowRadius: 20, shadowOffset: { width: 0, height: 8 }, elevation: 12 },
  backBtn: { position: "absolute", top: 12, left: 14, zIndex: 10, padding: 4 },
  backText: { fontSize: 13, color: "#555", fontWeight: "600" },
  header: { backgroundColor: "#F5C800", paddingTop: 28, paddingBottom: 14, alignItems: "center" },
  headerTitle: { fontSize: 28, fontWeight: "900", color: "#111", letterSpacing: 3 },
  categoryBlock: { paddingTop: 14, paddingBottom: 10, alignItems: "center" },
  categoryText: { fontSize: 15, fontWeight: "600", color: "#333" },
  garmentTypeText: { fontSize: 13, color: "#666", marginTop: 2 },
  divider: { height: 1, backgroundColor: "#ddd", marginHorizontal: 20 },
  detailBlock: { paddingVertical: 18, paddingHorizontal: 24, alignItems: "center", gap: 6 },
  sizeLabel: { fontSize: 16, color: "#333", fontWeight: "500" },
  sizeValue: { fontSize: 16, fontWeight: "800", color: "#111" },
  priceValue: { fontSize: 44, fontWeight: "900", color: "#111", letterSpacing: -1 },
  barcodeBlock: { paddingVertical: 16, alignItems: "center", gap: 6 },
  barcodeRow: { flexDirection: "row", alignItems: "flex-end", height: 44 },
  barcodeNum: { fontSize: 10, color: "#555", letterSpacing: 2, fontFamily: "Courier" },
});
