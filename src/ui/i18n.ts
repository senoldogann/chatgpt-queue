/**
 * Panel localisation.
 *
 * The English catalog is the source of truth for the key set: `MessageKey` is derived from it and
 * every other catalog is typed as a complete `Record<MessageKey, string>`, so a missing Turkish
 * string is a compile error rather than an English word leaking into a Turkish panel.
 *
 * Workflow prompts are deliberately not translated — they are instructions sent to ChatGPT, and
 * changing their language would change model behaviour without any UI benefit.
 */

export type Locale = 'en' | 'tr';
export type LocalePreference = 'auto' | Locale;

const en = {
  'app.title': 'Queue',
  'app.hide': 'Hide queue',
  'app.show': 'Show queue',
  'app.collapsedLabel': 'Queue · {count}',
  'app.guide': 'Guide',
  'app.language': 'Language',

  'status.idle': 'Idle',
  'status.running': 'Running',
  'status.paused': 'Paused',
  'status.blocked': 'Blocked',
  'status.completed': 'Completed',

  'action.start': 'Start queue',
  'action.pause': 'Pause',
  'action.resume': 'Resume',
  'action.add': 'Add',
  'action.save': 'Save',
  'action.delete': 'Delete',
  'action.moveUp': 'Move up',
  'action.moveDown': 'Move down',
  'action.clear': 'Clear',
  'action.runWorkflow': 'Run workflow',
  'action.usePreset': 'Use preset',
  'action.enable': 'Enable',
  'action.reconnect': 'Reconnect',
  'action.next': 'Next',
  'action.back': 'Back',
  'action.finish': 'Finish',
  'action.close': 'Close',

  'item.queued': 'Queued',
  'item.sending': 'Sending',
  'item.running': 'Running',
  'item.completed': 'Completed',
  'item.failed': 'Failed',
  'item.cancelled': 'Cancelled',
  'item.draftLabel': 'Queued message',
  'item.newMessagePlaceholder': 'Add follow-up message',
  'item.newMessageLabel': 'Add follow-up message',
  'list.empty': 'No queued messages.',

  'notice.blocked': 'Blocked',
  'notice.notice': 'Notice',
  'notice.ownedByOtherTab': 'Owned by another tab ({tabId})',
  'notice.domDiagnostics': 'DOM diagnostics: {summary}',
  'notice.migrationStopped': 'Queue migration stopped: {message}',
  'notice.pausedLocally': 'Queue paused locally: {message}',
  'notice.bridgeJobFailed': 'Bridge job failed: {message}',
  'notice.handoffUnavailableAdapter': 'Handoff unavailable: the adapter interface is {health}.',
  'notice.handoffUnavailableBusy': 'Handoff unavailable while the queue is actively sending. Pause it first.',
  'notice.handoffAlreadyReady': 'A handoff brief is already ready. Continue in a new chat.',
  'notice.handoffPrepareFailed': 'Could not prepare a handoff: {message}',
  'notice.handoffOpened': 'Opened a new chat for the handoff (tab {tabId}); it imports the brief on load.',
  'notice.handoffOpenFailed': 'Unable to open a handoff chat: {message}',
  'notice.handoffImported': 'Handoff imported: {count} queued messages from the previous conversation.',
  'notice.handoffImportedOne': 'Handoff imported: 1 queued message from the previous conversation.',
  'notice.handoffImportFailed': 'Handoff import failed: {message}',
  'notice.handoffRejected': 'Handoff brief rejected: {errors}',
  'notice.noHandoff': 'No handoff brief is ready.',
  'notice.invalidWorkflowJson': 'Invalid JSON: {message}',
  'notice.unknownWorkflowPreset': 'Unknown workflow preset: {presetId}',
  'notice.noWorkflowLoaded': 'No workflow loaded.',

  'workflow.title': 'Workflow',
  'workflow.subtitle': 'FlowRun',
  'workflow.stepsCount': '{count} steps',
  'workflow.busyHint': 'Finish or clear the current queue before starting a workflow.',
  'workflow.builtinLabel': 'Built-in workflows',
  'workflow.choosePlaceholder': 'Choose a built-in workflow',
  'workflow.defaultDescription': 'Choose a proven local workflow and review its inputs before running.',
  'workflow.or': 'or',
  'workflow.loadCustom': 'Load custom workflow',
  'workflow.progress': '{done} / {total}',

  'bridge.label': 'CLI bridge',
  'bridge.connected': 'Connected',
  'bridge.disconnected': 'Disconnected',
  'bridge.disabled': 'Disabled',
  'bridge.enabling': 'Enabling…',

  'context.title': 'Context',
  'context.subtitle': 'local estimate',
  'context.unavailable': 'Context pressure unavailable.',
  'context.pressure': '~{percent}% of {capacity} tokens (est. {estimated} over {turns} turns, {source})',
  'context.interfaceDetail': 'Interface detail',
  'context.capacityLabel': 'Capacity override (tokens)',
  'context.capacityPlaceholder': 'auto',

  'adapter.ok': 'interface ok',
  'adapter.degraded': 'interface degraded',
  'adapter.unrecognized': 'interface unrecognized',

  'handoff.preparing': 'Preparing handoff brief…',
  'handoff.ready': 'Handoff ready · {count} items carried',
  'handoff.readyOne': 'Handoff ready · 1 item carried',
  'handoff.open': 'Continue in new chat',
  'handoff.prepare': 'Compact & continue',
  'handoff.hintAdapter': 'The adapter must recognize this page before a handoff can be prepared.',
  'handoff.hintBusy': 'Available once the queue is idle. Queued follow-ups are carried over.',
  'handoff.hintReady': 'Asks ChatGPT for a handoff brief, then opens a fresh chat with it.',

  'locale.label': 'Language',
  'locale.auto': 'Auto',

  'guide.open': 'Open the guide',
  'guide.title': 'How to use this panel',
  'guide.progress': 'Step {current} / {total}',
  'guide.done': 'You have seen every step. The panel stays hidden until you show it again.',

  'guide.welcome.title': 'Welcome',
  'guide.welcome.body': 'This panel lives on ChatGPT and queues your follow-ups. It never sends while a response is still generating, and it blocks instead of guessing when the page looks wrong. Walk through these steps once and every control will be familiar.',
  'guide.add.title': 'Add a follow-up',
  'guide.add.body': 'Type the next message and press Add. It lands in the queue as a draft you can still edit, reorder, or delete.',
  'guide.start.title': 'Start, pause, resume',
  'guide.start.body': 'Start sends one item at a time. Pause lets the current answer finish but stops the next send. Resume continues from exactly where it stopped — no message is ever sent twice.',
  'guide.items.title': 'Edit and reorder',
  'guide.items.body': 'Each queued row has a text field plus Save, Delete and the arrow buttons. Reordering only moves queued items, so finished history stays intact.',
  'guide.status.title': 'Read the status',
  'guide.status.body': 'The spinner means work is in progress. Blocked always comes with a reason underneath it, and a blocked queue never retries a send on its own.',
  'guide.context.title': 'Watch the context estimate',
  'guide.context.body': 'This local estimate shows how much of the conversation window is used. The capacity comes from the page, then from your own override, then from a labeled conservative fallback — and the number is always an estimate, never a measurement.',
  'guide.handoff.title': 'Compact and continue',
  'guide.handoff.body': 'When a conversation is close to its limit, press Compact & continue. It asks ChatGPT for a handoff brief, validates it, pauses the queue, and opens a fresh chat stocked with that brief and your remaining follow-ups.',
  'guide.workflow.title': 'Run a built-in workflow',
  'guide.workflow.body': 'Choose one of the built-in workflows for a multi-step review, or load your own .flowrun.json file. Fill the inputs, then Run workflow — it chains each answer into the next prompt.',
  'guide.bridge.title': 'Connect the CLI bridge',
  'guide.bridge.body': 'Optional. Enable the CLI bridge if you want to start FlowRun workflows from a terminal and walk away. It asks for the nativeMessaging permission only at that moment.',
  'guide.interface.title': 'Check the interface',
  'guide.interface.body': 'The Context section also reports whether this build still recognizes the ChatGPT page. Interface detail prints the raw selectors, which is the fastest way to see that ChatGPT changed its markup.',

  'reason.uncertain-send': 'The send could not be confirmed, so it is never retried automatically',
  'reason.dom-unrecognized': 'The ChatGPT interface was not recognized',
  'reason.confirmation-required': 'A confirmation or tool-approval dialog is open',
  'reason.blocking-error': 'ChatGPT is showing an error state',
  'reason.chatgpt-error': 'ChatGPT reported an error',
  'reason.rate-limit': 'The request limit was reached',
  'reason.network-error': 'Network or connection error',
  'reason.session-expired': 'The session looks expired',
  'reason.message-delivery-timeout': 'Message delivery timed out',
  'reason.browser-session-interrupted': 'The browser session was interrupted',
  'reason.conversation-owner-mismatch': 'Another tab owns this conversation',
  'reason.send-not-confirmed': 'The send click could not be confirmed',
  'reason.send-not-attempted': 'The message could not be sent',
  'reason.generation-start-not-observed': 'The start of generation was not observed',
  'reason.active-item-missing': 'The active queue item record is missing',
  'reason.queue-busy': 'The queue is busy',
  'reason.provider-unavailable': 'The model provider is unavailable',
  'reason.template-error': 'Workflow template error',
  'reason.invalid-inputs': 'Workflow inputs are invalid',
  'reason.assistant-output-unavailable': 'The assistant output could not be read',
  'reason.assistant-turn-not-advanced': 'No new assistant response appeared',
  'reason.queue-item-not-completed': 'A queue item did not complete',
  'reason.queue-item-not-created': 'A queue item could not be created',
  'reason.flowrun-queue-item-missing': 'The workflow queue item is missing',
} as const;

export type MessageKey = keyof typeof en;

const tr: Record<MessageKey, string> = {
  'app.title': 'Kuyruk',
  'app.hide': 'Kuyruğu gizle',
  'app.show': 'Kuyruğu göster',
  'app.collapsedLabel': 'Kuyruk · {count}',
  'app.guide': 'Kılavuz',
  'app.language': 'Dil',

  'status.idle': 'Boşta',
  'status.running': 'Çalışıyor',
  'status.paused': 'Duraklatıldı',
  'status.blocked': 'Engellendi',
  'status.completed': 'Tamamlandı',

  'action.start': 'Kuyruğu başlat',
  'action.pause': 'Duraklat',
  'action.resume': 'Devam et',
  'action.add': 'Ekle',
  'action.save': 'Kaydet',
  'action.delete': 'Sil',
  'action.moveUp': 'Yukarı taşı',
  'action.moveDown': 'Aşağı taşı',
  'action.clear': 'Temizle',
  'action.runWorkflow': 'İş akışını çalıştır',
  'action.usePreset': 'Hazır akışı kullan',
  'action.enable': 'Etkinleştir',
  'action.reconnect': 'Yeniden bağlan',
  'action.next': 'İleri',
  'action.back': 'Geri',
  'action.finish': 'Bitir',
  'action.close': 'Kapat',

  'item.queued': 'Sırada',
  'item.sending': 'Gönderiliyor',
  'item.running': 'Çalışıyor',
  'item.completed': 'Tamamlandı',
  'item.failed': 'Başarısız',
  'item.cancelled': 'İptal edildi',
  'item.draftLabel': 'Sıradaki mesaj',
  'item.newMessagePlaceholder': 'Takip mesajı ekle',
  'item.newMessageLabel': 'Takip mesajı ekle',
  'list.empty': 'Sırada mesaj yok.',

  'notice.blocked': 'Engellendi',
  'notice.notice': 'Bilgi',
  'notice.ownedByOtherTab': 'Bu sohbeti başka bir sekme yönetiyor ({tabId})',
  'notice.domDiagnostics': 'DOM tanılaması: {summary}',
  'notice.migrationStopped': 'Kuyruk taşıma durdu: {message}',
  'notice.pausedLocally': 'Kuyruk yerel olarak duraklatıldı: {message}',
  'notice.bridgeJobFailed': 'Köprü işi başarısız: {message}',
  'notice.handoffUnavailableAdapter': 'Devir kullanılamıyor: arayüz durumu {health}.',
  'notice.handoffUnavailableBusy': 'Kuyruk etkin şekilde gönderirken devir kullanılamaz. Önce duraklatın.',
  'notice.handoffAlreadyReady': 'Bir devir özeti zaten hazır. Yeni sohbette sürdürün.',
  'notice.handoffPrepareFailed': 'Devir hazırlanamadı: {message}',
  'notice.handoffOpened': 'Devir için yeni sohbet açıldı (sekme {tabId}); yüklendiğinde özeti alır.',
  'notice.handoffOpenFailed': 'Devir sohbeti açılamadı: {message}',
  'notice.handoffImported': 'Devir alındı: önceki sohbetten {count} mesaj sıraya eklendi.',
  'notice.handoffImportedOne': 'Devir alındı: önceki sohbetten 1 mesaj sıraya eklendi.',
  'notice.handoffImportFailed': 'Devir alınamadı: {message}',
  'notice.handoffRejected': 'Devir özeti reddedildi: {errors}',
  'notice.noHandoff': 'Hazır bir devir özeti yok.',
  'notice.invalidWorkflowJson': 'Geçersiz JSON: {message}',
  'notice.unknownWorkflowPreset': 'Bilinmeyen iş akışı: {presetId}',
  'notice.noWorkflowLoaded': 'Yüklü bir iş akışı yok.',

  'workflow.title': 'İş akışı',
  'workflow.subtitle': 'FlowRun',
  'workflow.stepsCount': '{count} adım',
  'workflow.busyHint': 'Bir iş akışı başlatmadan önce mevcut kuyruğu bitirin veya temizleyin.',
  'workflow.builtinLabel': 'Yerleşik iş akışları',
  'workflow.choosePlaceholder': 'Yerleşik bir iş akışı seçin',
  'workflow.defaultDescription': 'Kanıtlanmış yerel bir iş akışı seçin; çalıştırmadan önce girdilerini gözden geçirin.',
  'workflow.or': 'veya',
  'workflow.loadCustom': 'Özel iş akışı yükle',
  'workflow.progress': '{done} / {total}',

  'bridge.label': 'CLI köprüsü',
  'bridge.connected': 'Bağlı',
  'bridge.disconnected': 'Bağlantı kesildi',
  'bridge.disabled': 'Kapalı',
  'bridge.enabling': 'Etkinleştiriliyor…',

  'context.title': 'Bağlam',
  'context.subtitle': 'yerel tahmin',
  'context.unavailable': 'Bağlam baskısı hesaplanamadı.',
  'context.pressure': '~%{percent} · {capacity} token (tahmini {estimated}, {turns} tur, kaynak: {source})',
  'context.interfaceDetail': 'Arayüz ayrıntısı',
  'context.capacityLabel': 'Kapasite geçersiz kılma (token)',
  'context.capacityPlaceholder': 'otomatik',

  'adapter.ok': 'arayüz uygun',
  'adapter.degraded': 'arayüz kısmi',
  'adapter.unrecognized': 'arayüz tanınmadı',

  'handoff.preparing': 'Devir özeti hazırlanıyor…',
  'handoff.ready': 'Devir hazır · {count} öğe taşınacak',
  'handoff.readyOne': 'Devir hazır · 1 öğe taşınacak',
  'handoff.open': 'Yeni sohbette sürdür',
  'handoff.prepare': 'Sıkıştır ve sürdür',
  'handoff.hintAdapter': 'Devir hazırlamadan önce arayüzün bu sayfayı tanıması gerekiyor.',
  'handoff.hintBusy': 'Kuyruk boştayken kullanılabilir. Sıradaki mesajlar yeni sohbete taşınır.',
  'handoff.hintReady': "ChatGPT'den bir devir özeti ister, sonra onunla yeni bir sohbet açar.",

  'locale.label': 'Dil',
  'locale.auto': 'Otomatik',

  'guide.open': 'Kılavuzu aç',
  'guide.title': 'Bu panel nasıl kullanılır',
  'guide.progress': 'Adım {current} / {total}',
  'guide.done': 'Tüm adımları gördünüz. Panel, siz tekrar gösterene kadar gizli kalır.',

  'guide.welcome.title': 'Hoş geldiniz',
  'guide.welcome.body': 'Bu panel ChatGPT üzerinde çalışır ve takip mesajlarınızı sıraya koyar. Yanıt üretilirken asla göndermez; sayfa tanınmadığında tahmin etmek yerine engeller. Adımları bir kez gezin, tüm düğmeler tanıdık hale gelir.',
  'guide.add.title': 'Takip mesajı ekleyin',
  'guide.add.body': 'Sıradaki mesajı yazıp Ekle’ye basın. Mesaj, düzenleyip sıralayabileceğiniz ve silebileceğiniz bir taslak olarak kuyruğa girer.',
  'guide.start.title': 'Başlat, duraklat, devam et',
  'guide.start.body': 'Başlat, mesajları tek tek gönderir. Duraklat, süren yanıtın bitmesine izin verir ama sonraki gönderimi durdurur. Devam et, kaldığı yerden sürdürür; hiçbir mesaj iki kez gönderilmez.',
  'guide.items.title': 'Düzenleme ve sıralama',
  'guide.items.body': 'Sıradaki her satırda bir metin alanı ile Kaydet, Sil ve ok düğmeleri var. Sıralama yalnızca bekleyen öğeleri taşır; tamamlanmış geçmiş bozulmaz.',
  'guide.status.title': 'Durumu okuyun',
  'guide.status.body': 'Dönen simge, çalışma sürdüğünü gösterir. Engellendi durumu her zaman altında bir nedenle gelir ve engellenen kuyruk gönderimi kendi başına tekrar denemez.',
  'guide.context.title': 'Bağlam tahminini izleyin',
  'guide.context.body': 'Bu yerel tahmin, sohbet penceresinin ne kadarının dolduğunu gösterir. Kapasite önce sayfadan, sonra sizin girdinizden, en sonunda etiketli temkinli bir varsayılandan gelir — değer her zaman tahmindir, ölçüm değil.',
  'guide.handoff.title': 'Sıkıştır ve sürdür',
  'guide.handoff.body': 'Sohbet limite yaklaştığında Sıkıştır ve sürdür’e basın. ChatGPT’den bir devir özeti ister, özeti doğrular, kuyruğu duraklatır ve kalan mesajlarınızla birlikte yeni bir sohbet açar.',
  'guide.workflow.title': 'Yerleşik bir iş akışı çalıştırın',
  'guide.workflow.body': 'Çok adımlı bir inceleme için yerleşik iş akışlarından birini seçin ya da kendi .flowrun.json dosyanızı yükleyin. Girdileri doldurup İş akışını çalıştır’a basın; her yanıt sonraki isteme aktarılır.',
  'guide.bridge.title': 'CLI köprüsünü bağlayın',
  'guide.bridge.body': 'İsteğe bağlı. FlowRun iş akışlarını terminalden başlatıp bırakmak isterseniz CLI köprüsünü etkinleştirin. nativeMessaging iznini yalnızca o anda ister.',
  'guide.interface.title': 'Arayüzü kontrol edin',
  'guide.interface.body': 'Bağlam bölümü, bu sürümün ChatGPT sayfasını hâlâ tanıyıp tanımadığını da bildirir. Arayüz ayrıntısı ham seçicileri yazdırır; ChatGPT işaretlemesini değiştirdiyse bunu görmenin en hızlı yolu budur.',

  'reason.uncertain-send': 'Gönderim doğrulanamadı, bu yüzden otomatik olarak yeniden gönderilmez',
  'reason.dom-unrecognized': 'ChatGPT arayüzü tanınamadı',
  'reason.confirmation-required': 'Onay veya araç izni bekleyen bir pencere açık',
  'reason.blocking-error': 'ChatGPT bir hata durumu gösteriyor',
  'reason.chatgpt-error': 'ChatGPT bir hata bildirdi',
  'reason.rate-limit': 'İstek limiti aşıldı',
  'reason.network-error': 'Ağ veya bağlantı hatası',
  'reason.session-expired': 'Oturum sona ermiş görünüyor',
  'reason.message-delivery-timeout': 'Mesaj iletimi zaman aşımına uğradı',
  'reason.browser-session-interrupted': 'Tarayıcı oturumu kesintiye uğradı',
  'reason.conversation-owner-mismatch': 'Bu sohbeti başka bir sekme yönetiyor',
  'reason.send-not-confirmed': 'Gönderme tıklaması doğrulanamadı',
  'reason.send-not-attempted': 'Mesaj gönderilemedi',
  'reason.generation-start-not-observed': 'Yanıt üretiminin başladığı gözlemlenemedi',
  'reason.active-item-missing': 'Etkin kuyruk öğesi kaydı bulunamadı',
  'reason.queue-busy': 'Kuyruk meşgul',
  'reason.provider-unavailable': 'Model sağlayıcısı kullanılamıyor',
  'reason.template-error': 'İş akışı şablon hatası',
  'reason.invalid-inputs': 'İş akışı girdileri geçersiz',
  'reason.assistant-output-unavailable': 'Asistan çıktısı okunamadı',
  'reason.assistant-turn-not-advanced': 'Yeni bir asistan yanıtı görünmedi',
  'reason.queue-item-not-completed': 'Bir kuyruk öğesi tamamlanmadı',
  'reason.queue-item-not-created': 'Bir kuyruk öğesi oluşturulamadı',
  'reason.flowrun-queue-item-missing': 'İş akışının kuyruk öğesi bulunamadı',
};

export const CATALOGS: Record<Locale, Record<MessageKey, string>> = { en, tr };

export const LOCALES: readonly Locale[] = ['en', 'tr'];

/** Falls back to English for any unknown locale, and never throws on a missing key. */
export const resolveLocale = (preference: LocalePreference, language: string): Locale => {
  if (preference !== 'auto') return preference;
  return language.toLowerCase().startsWith('tr') ? 'tr' : 'en';
};

export type TranslateParams = Record<string, string | number>;

export const translate = (locale: Locale, key: MessageKey, params?: TranslateParams): string => {
  const template = CATALOGS[locale]?.[key] ?? CATALOGS.en[key] ?? key;
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (_match, name: string) =>
    name in params ? String(params[name]) : `{${name}}`);
};

export const createTranslator = (locale: Locale) =>
  (key: MessageKey, params?: TranslateParams): string => translate(locale, key, params);

export type Translator = ReturnType<typeof createTranslator>;
