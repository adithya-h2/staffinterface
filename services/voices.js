// Language → Voice Routing Map
// Routes each language to native voice & locale using browser SpeechSynthesis API
// No external dependencies - pure browser-native voice engine

const VoiceRoutes = {
    "en":   { lang: "en-US", speaker: "default", model: "browser", style: "neutral" }, // English - browser native
    "hi":   { lang: "hi-IN", speaker: "default", model: "browser", style: "native"  }, // Hindi - browser native
    "kn":   { lang: "kn-IN", speaker: "default", model: "browser", style: "native"  }, // Kannada - browser native
    "ta":   { lang: "ta-IN", speaker: "default", model: "browser", style: "native"  }, // Tamil - browser native
    "te":   { lang: "te-IN", speaker: "default", model: "browser", style: "native"  }, // Telugu - browser native
    "ml":   { lang: "ml-IN", speaker: "default", model: "browser", style: "native"  }, // Malayalam - browser native
    "bn":   { lang: "bn-IN", speaker: "default", model: "browser", style: "native"  }, // Bengali - browser native
    "mr":   { lang: "mr-IN", speaker: "default", model: "browser", style: "native"  }, // Marathi - browser native
    "gu":   { lang: "gu-IN", speaker: "default", model: "browser", style: "native"  }, // Gujarati - browser native
    "pa":   { lang: "pa-IN", speaker: "default", model: "browser", style: "native"  }, // Punjabi - browser native
    "od":   { lang: "od-IN", speaker: "default", model: "browser", style: "native"  }  // Odia - browser native
};

// Hard fallback if detector returns variants like "hi" vs "hi-IN"
function routeVoice(langCode) {
    const key = (langCode || "").toLowerCase();
    
    if (key.startsWith("en")) return VoiceRoutes.en;
    if (key.startsWith("hi")) return VoiceRoutes.hi;
    if (key.startsWith("kn")) return VoiceRoutes.kn;
    if (key.startsWith("ta")) return VoiceRoutes.ta;
    if (key.startsWith("te")) return VoiceRoutes.te;
    if (key.startsWith("ml")) return VoiceRoutes.ml;
    if (key.startsWith("bn")) return VoiceRoutes.bn;
    if (key.startsWith("mr")) return VoiceRoutes.mr;
    if (key.startsWith("gu")) return VoiceRoutes.gu;
    if (key.startsWith("pa")) return VoiceRoutes.pa;
    if (key.startsWith("od")) return VoiceRoutes.od;
    
    // default: neutral English (never Indianize English)
    return VoiceRoutes.en;
}

module.exports = {
    VoiceRoutes,
    routeVoice
};

