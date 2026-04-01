require('dotenv').config();

const express = require('express');
const axios = require('axios');
const TelegramBot = require('node-telegram-bot-api');
const FormData = require('form-data');
const { Sequelize, DataTypes, Op } = require('sequelize');

const TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID = parseInt(process.env.ADMIN_ID, 10);
const DATABASE_URL = process.env.DATABASE_URL;

if (!TOKEN || Number.isNaN(ADMIN_ID) || !DATABASE_URL) {
  console.error('❌ Missing required environment variables');
  process.exit(1);
}

const bot = new TelegramBot(TOKEN, { polling: true });
const app = express();
app.use(express.json());

const sequelize = new Sequelize(DATABASE_URL, {
  dialect: 'postgres',
  logging: false,
  dialectOptions: {
    ssl: { require: true, rejectUnauthorized: false }
  },
  pool: { max: 10, min: 0, acquire: 30000, idle: 10000 }
});

const User = sequelize.define('User', {
  id: { type: DataTypes.BIGINT, primaryKey: true },
  lang: { type: DataTypes.STRING(2), defaultValue: 'en' },
  balance: { type: DataTypes.DECIMAL(10, 2), defaultValue: 0.00 },
  state: { type: DataTypes.TEXT, allowNull: true },
  referralCode: { type: DataTypes.STRING, unique: true, allowNull: true },
  referredBy: { type: DataTypes.BIGINT, allowNull: true },
  referralPoints: { type: DataTypes.INTEGER, defaultValue: 0 },
  freeChatgptReceived: { type: DataTypes.BOOLEAN, defaultValue: false },
  lastFreeCodeClaimAt: { type: DataTypes.DATE, allowNull: true },
  creatorDiscountPercent: { type: DataTypes.INTEGER, defaultValue: 0 },
  adminGrantedPoints: { type: DataTypes.INTEGER, defaultValue: 0 },
  referralMilestoneGrantedPoints: { type: DataTypes.INTEGER, defaultValue: 0 },
  referralStockClaimedCodes: { type: DataTypes.INTEGER, defaultValue: 0 },
  totalPurchases: { type: DataTypes.INTEGER, defaultValue: 0 },
  verified: { type: DataTypes.BOOLEAN, defaultValue: false },
  referralRewarded: { type: DataTypes.BOOLEAN, defaultValue: false }
});

const Setting = sequelize.define('Setting', {
  key: { type: DataTypes.STRING, allowNull: false },
  lang: { type: DataTypes.STRING(10), allowNull: false },
  value: { type: DataTypes.TEXT, allowNull: false }
}, {
  indexes: [{ unique: true, fields: ['key', 'lang'] }]
});

const Merchant = sequelize.define('Merchant', {
  id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
  nameEn: { type: DataTypes.STRING, allowNull: false },
  nameAr: { type: DataTypes.STRING, allowNull: false },
  price: { type: DataTypes.FLOAT, allowNull: false, defaultValue: 0 },
  category: { type: DataTypes.STRING, defaultValue: 'general' },
  type: { type: DataTypes.STRING, defaultValue: 'single' },
  description: { type: DataTypes.JSONB, allowNull: true }
});

const PaymentMethod = sequelize.define('PaymentMethod', {
  id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
  nameEn: { type: DataTypes.STRING, allowNull: false },
  nameAr: { type: DataTypes.STRING, allowNull: false },
  details: { type: DataTypes.TEXT, allowNull: false },
  type: { type: DataTypes.STRING, defaultValue: 'manual' },
  config: { type: DataTypes.JSONB, defaultValue: {} },
  isActive: { type: DataTypes.BOOLEAN, defaultValue: true },
  minDeposit: { type: DataTypes.FLOAT, defaultValue: 1.0 },
  maxDeposit: { type: DataTypes.FLOAT, defaultValue: 10000.0 }
});

const Code = sequelize.define('Code', {
  id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
  value: { type: DataTypes.TEXT, allowNull: false },
  extra: { type: DataTypes.TEXT, allowNull: true },
  merchantId: { type: DataTypes.INTEGER, references: { model: Merchant, key: 'id' } },
  isUsed: { type: DataTypes.BOOLEAN, defaultValue: false },
  usedBy: { type: DataTypes.BIGINT, allowNull: true },
  soldAt: { type: DataTypes.DATE, allowNull: true },
  expiresAt: { type: DataTypes.DATE, allowNull: true }
});

const BalanceTransaction = sequelize.define('BalanceTransaction', {
  id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
  userId: { type: DataTypes.BIGINT, allowNull: false },
  amount: { type: DataTypes.DECIMAL(10, 2), allowNull: false },
  type: { type: DataTypes.STRING, allowNull: false },
  paymentMethodId: { type: DataTypes.INTEGER, references: { model: PaymentMethod, key: 'id' }, allowNull: true },
  txid: { type: DataTypes.STRING, allowNull: true },
  imageFileId: { type: DataTypes.STRING, allowNull: true },
  caption: { type: DataTypes.TEXT, allowNull: true },
  status: { type: DataTypes.STRING, defaultValue: 'pending' },
  adminMessageId: { type: DataTypes.BIGINT, allowNull: true },
  lastReminderAt: { type: DataTypes.DATE, allowNull: true },
  createdAt: { type: DataTypes.DATE, defaultValue: DataTypes.NOW }
});

const BotService = sequelize.define('BotService', {
  id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
  token: { type: DataTypes.STRING, unique: true, allowNull: false },
  name: { type: DataTypes.STRING, allowNull: false },
  allowedActions: { type: DataTypes.JSONB, defaultValue: [] },
  ownerId: { type: DataTypes.BIGINT, allowNull: true },
  isActive: { type: DataTypes.BOOLEAN, defaultValue: true }
});

const BotStat = sequelize.define('BotStat', {
  botId: { type: DataTypes.INTEGER, references: { model: BotService, key: 'id' } },
  action: { type: DataTypes.STRING },
  count: { type: DataTypes.INTEGER, defaultValue: 0 },
  lastUsed: { type: DataTypes.DATE }
});

const DiscountCode = sequelize.define('DiscountCode', {
  id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
  code: { type: DataTypes.STRING, unique: true, allowNull: false },
  discountPercent: { type: DataTypes.INTEGER, defaultValue: 0 },
  validUntil: { type: DataTypes.DATE, allowNull: true },
  maxUses: { type: DataTypes.INTEGER, defaultValue: 1 },
  usedCount: { type: DataTypes.INTEGER, defaultValue: 0 },
  createdBy: { type: DataTypes.BIGINT, allowNull: false }
});

const ReferralReward = sequelize.define('ReferralReward', {
  id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
  referrerId: { type: DataTypes.BIGINT, allowNull: false },
  referredId: { type: DataTypes.BIGINT, allowNull: false },
  amount: { type: DataTypes.DECIMAL(10, 2), allowNull: false },
  status: { type: DataTypes.STRING, defaultValue: 'pending' }
});

const RedeemService = sequelize.define('RedeemService', {
  id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
  nameEn: { type: DataTypes.STRING, allowNull: false },
  nameAr: { type: DataTypes.STRING, allowNull: false },
  merchantDictId: { type: DataTypes.STRING, allowNull: false },
  platformId: { type: DataTypes.STRING, defaultValue: '1' }
});

const DepositConfig = sequelize.define('DepositConfig', {
  id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
  currency: { type: DataTypes.STRING, allowNull: false, unique: true },
  rate: { type: DataTypes.FLOAT, defaultValue: 1500 },
  walletAddress: { type: DataTypes.STRING, allowNull: false },
  instructions: { type: DataTypes.TEXT, allowNull: false },
  displayNameEn: { type: DataTypes.STRING, allowNull: true },
  displayNameAr: { type: DataTypes.STRING, allowNull: true },
  templateEn: { type: DataTypes.TEXT, allowNull: true },
  templateAr: { type: DataTypes.TEXT, allowNull: true },
  methods: { type: DataTypes.JSONB, defaultValue: [] },
  isActive: { type: DataTypes.BOOLEAN, defaultValue: true }
});

const ChannelConfig = sequelize.define('ChannelConfig', {
  id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
  enabled: { type: DataTypes.BOOLEAN, defaultValue: false },
  link: { type: DataTypes.STRING, allowNull: true },
  messageText: { type: DataTypes.TEXT, allowNull: true },
  chatId: { type: DataTypes.STRING, allowNull: true },
  username: { type: DataTypes.STRING, allowNull: true },
  title: { type: DataTypes.STRING, allowNull: true }
});

const Captcha = sequelize.define('Captcha', {
  userId: { type: DataTypes.BIGINT, primaryKey: true },
  challenge: { type: DataTypes.STRING, allowNull: false },
  answer: { type: DataTypes.INTEGER, allowNull: false },
  expiresAt: { type: DataTypes.DATE, allowNull: false }
});

Merchant.hasMany(Code, { foreignKey: 'merchantId' });
Code.belongsTo(Merchant);
BalanceTransaction.belongsTo(User, { foreignKey: 'userId' });
BalanceTransaction.belongsTo(PaymentMethod);
BotService.hasMany(BotStat, { foreignKey: 'botId' });
BotStat.belongsTo(BotService);
User.hasMany(ReferralReward, { as: 'Referrer', foreignKey: 'referrerId' });
User.hasMany(ReferralReward, { as: 'Referred', foreignKey: 'referredId' });
DiscountCode.belongsTo(User, { as: 'creator', foreignKey: 'createdBy' });

const DEFAULT_TEXTS = {
  en: {
    start: '🌍 Choose language',
    menu: '👋 Main menu:',
    redeem: '🔄 Redeem Code',
    buy: '🛒 Buy Codes',
    myBalance: '💰 My Balance',
    deposit: '💳 Deposit',
    support: '📞 Support',
    chooseMerchant: '👋 Choose merchant:',
    processing: '⏳ Processing...',
    enterQty: '✍️ Enter quantity:',
    noCodes: '❌ Not enough codes in stock',
    back: '🔙 Back',
    adminPanel: '🔧 Admin Panel',
    addMerchant: '➕ Add Merchant',
    listMerchants: '📋 List Merchants',
    addCodes: '📦 Add Codes',
    stats: '📊 Stats',
    setPrice: '💰 Set Price',
    setChatgptPrice: '🤖 Set ChatGPT Price',
    enterChatgptPrice: 'Send new ChatGPT code price (USD):',
    chatgptPriceUpdated: '✅ ChatGPT code price updated to {price} USD!',
    paymentMethods: '💳 Payment Methods',
    manageBots: '🤖 Manage Bots',
    manageMenuButtons: '🎛️ Manage Menu Buttons',
    moveUp: '⬆️ Move Up',
    moveDown: '⬇️ Move Down',
    buttonOrderUpdated: '✅ Button order updated!',
    manageChannel: '📢 Manage Required Channel',
    manageDepositSettings: '💱 Manage Deposit Settings',
    referralSettings: '👥 Referral Settings',
    manageRedeemServices: '🔄 Manage Redeem Services',
    manageDiscountCodes: '🎟️ Manage Discount Codes',
    sendAnnouncement: '📢 Send Announcement',
    editCodeDeliveryMessage: '✏️ Edit Code Delivery Message',
    chooseCodeMessageLanguage: 'Choose the language of the code message:',
    codeMessageArabic: '🇮🇶 Arabic Code Message',
    codeMessageEnglish: '🇺🇸 English Code Message',
    enterAnnouncementText: 'Send the announcement/notice text to broadcast to bot users:',
    announcementSent: '✅ Announcement sent. Delivered: {sent} | Failed: {failed}',
    enterCodeDeliveryMessage: 'Send the text you want to appear before the code. Send /empty to clear it.',
    codeDeliveryMessageUpdated: '✅ Code delivery message updated.',
    enterBotToken: 'Send bot token:',
    botAdded: '✅ Bot added!',
    botRemoved: '❌ Bot removed!',
    chooseCurrency: '💱 Choose currency for deposit:',
    currency_usd_name: 'Binance',
    currency_iqd_name: 'Iraqi Dinar',
    depositInstructionsUSD: '💰 Send {amount} USDT to one of the following payment methods:\n\n{methods_block}\n\nThen send a screenshot of the payment with any message.\n\n{instructions}',
    depositInstructionsIQD: '💰 Send {amountIQD} Iraqi Dinar (≈ {amountUSD} USD at rate {rate} IQD/USD) to one of the following payment methods:\n\n{methods_block}\n\nThen send a screenshot of the payment with any message.\n\n{instructions}',
    depositProofReceived: '✅ Deposit proof received! Admin will review it shortly.',
    depositSuccess: '✅ Deposit successful! New balance: {balance} USD',
    depositRejected: '❌ Your deposit was rejected.',
    depositNotification: '💳 New deposit request from user {userId}\nAmount: {amount} {currency}\nPayment Method: {method}\n\nMessage: {message}',
    approve: '✅ Approve',
    reject: '❌ Reject',
    success: '✅ Purchase successful! Here are your codes:',
    error: '❌ Error',
    askMerchantNameEn: 'Send merchant name in English:',
    askMerchantNameAr: 'Send merchant name in Arabic:',
    askMerchantPrice: 'Send price in USD:',
    askMerchantType: 'Select merchant type:',
    typeSingle: 'Single (one code per line)',
    typeBulk: 'Bulk (email/password pairs)',
    askDescription: 'Send description (text, photo, video, or /skip):',
    merchantCreated: '✅ Merchant created! ID: {id}',
    enterPrice: 'Enter new price (USD):',
    priceUpdated: '💰 Price updated!',
    enterCodes: 'Send codes separated by new lines or spaces:',
    codesAdded: '✅ Codes added successfully!',
    merchantList: '📋 Merchants list:\n',
    askCategory: 'Send category name:',
    categoryUpdated: 'Category updated!',
    setReferralPercent: 'Set referral reward percentage:',
    referralPercentUpdated: 'Referral reward percentage updated to {percent}%.',
    showDescription: '📖 View Description',
    redeemServiceNameEn: 'Send service name in English:',
    redeemServiceNameAr: 'Send service name in Arabic:',
    redeemServiceMerchantId: 'Send merchant dict ID (from NodeCard):',
    redeemServicePlatformId: 'Send platform ID (default 1):',
    redeemServiceAdded: '✅ Redeem service added!',
    chooseRedeemService: 'Choose the service to redeem:',
    sendCodeToRedeem: 'Send the code to redeem:',
    redeemSuccess: '✅ Card redeemed successfully!\n\n💳 Card Details:\n{details}',
    redeemFailed: '❌ Failed to redeem card: {reason}',
    listRedeemServices: '📋 List Redeem Services',
    addRedeemService: '➕ Add Redeem Service',
    deleteRedeemService: '🗑️ Delete Redeem Service',
    listDiscountCodes: '📋 List Discount Codes',
    addDiscountCode: '➕ Add Discount Code',
    deleteDiscountCode: '🗑️ Delete Discount Code',
    enterDiscountCodeValue: 'Enter discount code (e.g., SAVE10):',
    enterDiscountPercent: 'Enter discount percentage (e.g., 10):',
    enterDiscountValidUntil: 'Enter expiry date (YYYY-MM-DD) or /skip:',
    enterDiscountMaxUses: 'Enter max uses (e.g., 100):',
    discountCodeAdded: '✅ Discount code added!',
    discountCodeDeleted: '❌ Discount code deleted!',
    noDiscountCodes: 'No discount codes found.',
    enterDiscountCode: 'Send your discount code:',
    discountApplied: '✅ Discount code applied! You get {percent}% off.',
    discountInvalid: '❌ Invalid or expired discount code.',
    myPurchases: '📜 My Purchases',
    noPurchases: 'No purchases yet.',
    purchaseHistory: '🛍️ Purchase History:\n{history}',
    confirmDelete: '⚠️ Are you sure you want to delete this merchant?',
    yes: '✅ Yes',
    no: '❌ No',
    merchantDeleted: 'Merchant deleted successfully.',
    referral: '🤝 Invite Friends',
    redeemPoints: '🎁 Redeem Points',
    getFreeCode: '🎁 Get your free code',
    freeCodeMenu: '🎁 Get your free code',
    referralInfo: 'Share your referral link with friends and earn 1 point per successful referral!\n\nYour referral link:\n{link}\n\nYour points: {points}\nYou can get {redeemableCodes} code(s) with your points.\n🎁 Every {requiredPoints} points = 1 free ChatGPT code!',
    referralEarned: '🎉 You earned 1 referral point! Total points: {points}',
    notEnoughPoints: '❌ You do not have enough points. You have {points} points, and each code needs {requiredPoints} points.',
    redeemPointsAskAmount: 'Send the number of ChatGPT codes you want to redeem using your points. Each code costs {requiredPoints} points.',
    redeemPointsInvalidAmount: '❌ Invalid number. Send a valid positive number of codes.',
    pointsRedeemed: '✅ Points redeemed successfully! Here are your ChatGPT GO code(s):\n\n{code}',
    setRedeemPoints: '🎁 Set Redeem Points',
    enterRedeemPoints: 'Enter required points for a free ChatGPT code:',
    redeemPointsUpdated: '✅ Redeem points updated to {points}.',
    grantPoints: '🎁 Grant Points',
    enterGrantPointsUserId: 'Send the Telegram user ID of the user:',
    enterGrantPointsAmount: 'Send the number of points to grant:',
    grantPointsUserNotFound: '❌ User not found.',
    grantPointsDone: '✅ Added {points} points to user {userId}. New total: {total}',
    pointsGrantedNotification: '🎁 You received {points} referral points from admin. Your total points: {total}',
    setFreeCodeDays: '⏳ Set Free Code Cooldown',
    enterFreeCodeDays: 'Send the number of days before the free-code button appears again:',
    freeCodeDaysUpdated: '✅ Free-code cooldown updated to {days} day(s).',
    currentRedeemPoints: 'Current required points: {points}',
    currentReferralPercent: 'Current referral reward percentage: {percent}%',
    currentFreeCodeDays: 'Free-code cooldown: {days} day(s)',
    grantCreatorDiscount: '🎟️ Grant Creator Discount',
    editReferralMilestones: '🎯 Edit Referral Milestone Rewards',
    enterReferralMilestones: 'Send milestone rewards in this format:\n15:5,40:5,80:10,150:30',
    referralMilestonesUpdated: '✅ Referral milestone rewards updated.',
    currentReferralMilestones: 'Current milestone rewards: {milestones}',
    referralEligibleUsers: '🎁 Eligible Referral Users',
    deductReferralPoints: '➖ Deduct Points',
    referralStockSettings: '📦 Referral ChatGPT Stock',
    referralStockClaim: '🎁 Referral Prize',
    noReferralEligibleUsers: 'No users currently have referral history with redeemable referral compensation.',
    referralEligibleUsersTitle: 'Eligible referral users:',
    referralEligibleUserLine: 'Name: {name}\nUsername: {username}\nID: {id}\nTotal points: {points}\nGranted by admin: {adminGranted}\nReferral count: {referrals}\nMilestone rewards: {milestoneRewards}\nClaimed codes before: {claimedCodes}\nAvailable now: {redeemableCodes}',
    referralClaimAdminNotice: '🎁 Referral compensation claimed\nBy: {name}\nUsername: {username}\nID: {id}\nClaimed now: {claimedNow}\nClaimed before: {claimedBefore}\nTotal claimed after this: {claimedAfter}\nStill eligible now: {eligibleNow}\nCurrent referral points: {points}\nGranted by admin: {adminGranted}\nReferral count: {referrals}\nMilestone rewards: {milestoneRewards}',
    referralStockAccessDenied: '❌ This stock is only for users who have previous successful referrals.',
    enterDeductPointsUserId: 'Send the Telegram user ID whose points you want to deduct:',
    enterDeductPointsAmount: 'Send the number of points to deduct:',
    deductPointsDone: '✅ Points deducted. User {userId} now has {points} points.',
    deductPointsUserNotFound: '❌ User not found.',
    toggleReferrals: '🔁 Stop/Start Referrals',
    referralsEnabledStatus: '✅ Referrals counting is enabled',
    referralsDisabledStatus: '⛔ Referrals counting is stopped',
    referralsTurnedOn: '✅ Referrals enabled.',
    referralsTurnedOff: '⛔ Referrals stopped.',
    addReferralStockCodes: '➕ Add Referral Stock Codes',
    viewReferralStockCount: '📦 View Referral Stock',
    referralStockCountText: 'Referral ChatGPT stock: {count} code(s).',
    enterReferralStockCodes: 'Send referral ChatGPT stock codes separated by new lines or spaces:',
    referralStockCodesAdded: '✅ Referral stock codes added.',
    referralStockNotEnough: '❌ Not enough referral ChatGPT stock for this request.',
    referralStockNoCodesAvailable: '❌ No referral ChatGPT stock available right now.',
    referralClaimAskCount: 'Send the number of referral-stock codes you want to claim. Available by your points: {maxCodes}.',
    botAllowedUsers: '👤 Allowed Users While Bot Stopped',
    balanceManagement: '💰 Balance Management',
    usersWithBalance: '👥 Users With Balance',
    addBalanceAdmin: '➕ Add Balance',
    deductBalanceAdmin: '➖ Deduct Balance',
    enterBalanceUserId: 'Send the Telegram user ID:',
    enterBalanceAmount: 'Send the balance amount in USD:',
    usersWithBalanceTitle: 'Users with balance:',
    noUsersWithBalance: 'No users currently have a balance greater than 0.',
    balanceUserLine: 'Name: {name}\nUsername: {username}\nID: {id}\nBalance: {balance} USD',
    balanceUserNotFound: '❌ User not found.',
    balanceAmountInvalid: '❌ Invalid balance amount.',
    balanceAddedDone: '✅ Added {amount} USD to user {userId}. New balance: {balance} USD',
    balanceDeductedDone: '✅ Deducted {amount} USD from user {userId}. New balance: {balance} USD',
    balanceReceivedNotification: '💰 {amount} USD has been added to your balance. New balance: {balance} USD',
    balanceDeductedNotification: '💰 {amount} USD has been deducted from your balance. New balance: {balance} USD',
    stockClaimAdminShort: '📦 Stock withdrawal\nUser: {name}\nUsername: {username}\nID: {id}\nCount: {count}',
    balancePurchaseAdminNotice: '💳 Purchase by balance\nUser: {name}\nUsername: {username}\nID: {id}\nMerchant: {merchant}\nQuantity: {qty}\nTotal: {total} USD',
    enterAllowedUsers: 'Send allowed Telegram user IDs separated by commas, spaces, or new lines. Send /empty to clear.',
    allowedUsersUpdated: '✅ Allowed users updated.',
    currentAllowedUsers: 'Current allowed IDs: {ids}',
    quantityDiscountSettings: '💸 Quantity Discount Settings',
    setBulkDiscountThreshold: '📦 Set Discount Quantity',
    setBulkDiscountPrice: '💵 Set Price After Discount',
    enterBulkDiscountThreshold: 'Send the quantity at which the discount starts:',
    enterBulkDiscountPrice: 'Send the new per-code price after discount (USD):',
    currentBulkDiscountThreshold: 'Discount starts from quantity: {threshold}',
    currentBulkDiscountPrice: 'Price after discount: {price} USD per code',
    quantityDiscountSettingsText: '💸 Quantity Discount Settings\n\n{thresholdLine}\n{priceLine}',
    bulkDiscountSettingsUpdated: '✅ Quantity discount settings updated.',
    botControl: '🤖 Bot Control',
    botStatusLine: 'Current bot status: {status}',
    botEnabledStatus: '✅ Running',
    botDisabledStatus: '⛔ Stopped',
    enableBot: '✅ Turn Bot On',
    disableBot: '⛔ Turn Bot Off',
    botTurnedOn: '✅ Bot enabled for users.',
    botTurnedOff: '⛔ Bot stopped for users.',
    botPausedMessage: '⛔ The bot is temporarily stopped. Please try again later.',
    depositReminderPending: '⏰ Pending deposit reminder\nUser ID: {userId}\nAmount: {amount} {currency}',
    grantPointsDoneDetailed: '✅ Points granted successfully.\n\nUser ID: {userId}\nUsername: {username}\nName: {name}\nGranted now: {points}\nTotal points: {total}\nAdmin-granted points: {adminGranted}\nReferral count: {referrals}\nReferral rewards points: {milestoneRewards}',
    enterCreatorDiscountUserId: 'Send the Telegram user ID of the creator:',
    enterCreatorDiscountPercent: 'Send the discount percent for referral redemption (0-100):',
    creatorDiscountUserNotFound: '❌ User not found.',
    creatorDiscountUpdated: '✅ Creator discount for user {userId} updated to {percent}%. Effective required points: {requiredPoints}.',
    creatorDiscountGrantedNotification: '🎟️ You received a creator discount of {percent}%. Your required points per free code are now {requiredPoints}.',
    currentCreatorDiscount: 'Your creator discount: {percent}%',
    manageReferralSettingsText: '👥 Referral Settings\n\n{percentLine}\n{pointsLine}\n{freeCodeDaysLine}\n{milestonesLine}\n{referralsStatusLine}',
    chatgptCode: 'GPT',
    productsSection: '📦 Products Section',
    addProductSection: '➕ Add Section',
    manageProductSections: '📚 Manage Sections',
    enterSectionNameEn: 'Send section name in English:',
    enterSectionNameAr: 'Send section name in Arabic:',
    sectionAdded: '✅ Section added successfully.',
    productSectionsTitle: '📚 Product sections:',
    noProductSections: 'No sections found.',
    manageSection: '📂 Manage Section',
    renameSection: '✏️ Rename Section',
    deleteSection: '🗑️ Delete Section',
    sectionDeleted: '✅ Section deleted.',
    cannotDeleteGptSection: '❌ GPT section cannot be deleted.',
    addSectionProduct: '➕ Add Product In Section',
    manageSectionProducts: '📋 Manage Section Products',
    sectionManageText: 'Manage section: {name}',
    sectionChooseText: 'Choose a product from this section:',
    noSectionProducts: '❌ This section has no products yet.',
    setSectionName: '✏️ Set Section Name',
    sectionNameUpdated: '✅ Section name updated.',
    sectionProductsTitle: 'Products in section {name}:',
    manageProductInline: '⚙️ Manage Product',
    renameProduct: '✏️ Rename Product',
    deleteProduct: '🗑️ Delete Product',
    productDeleted: '✅ Product deleted.',
    chooseProductNameLanguage: 'Choose which product name to edit:',
    editNameArabic: '🇮🇶 Arabic Name',
    editNameEnglish: '🇺🇸 English Name',
    enterProductName: 'Send the new product name:',
    productUpdated: '✅ Product updated.',
    showOnHome: '📌 Show On Main Page',
    hideFromHome: '🚫 Hide From Main Page',
    featuredUpdated: '✅ Home visibility updated.',
    sectionButtonManageInfo: 'This section appears on the main page. From here you can rename it, add products, manage products, and delete the section.',
    typeCodeSingle: 'Code',
    typeAccountSingle: 'Email + Password',
    typeAccountVerifySingle: 'Email + Password + Verification',
    typeAccountBulk: 'Bulk Email + Password',
    typeAccountVerifyBulk: 'Bulk Email + Password + Verification',
    stockFormatCode: 'Send stock items. Each line = one code.',
    stockFormatAccount: 'Send stock items in pairs:\nemail\npassword',
    stockFormatAccountVerify: 'Send stock items in groups of 3 lines:\nemail\npassword\nverification',
    askEmail: 'Please enter your email address:',
    freeCodeSuccess: '🎉 Here is your free ChatGPT GO code:\n\n{code}',
    alreadyGotFree: 'You have already received your free code. You can purchase more codes.',
    askQuantity: 'How many ChatGPT codes would you like to buy? Send the number only.',
    enterEmailForPurchase: 'Enter your email to receive the code:',
    purchaseSuccess: '✅ Purchase successful! Here are your ChatGPT GO code(s):\n\n{code}',
    insufficientBalance: '❌ Insufficient balance. Your balance: {balance} USD. Price per code: {price} USD\n\nYou need: {needed} USD to get this quantity of codes.',
    depositNow: '💳 Deposit Balance',
    bulkDiscountInfo: '🔥 Quantity discount: if you buy {threshold} codes or more, the price becomes {price} USD per code.',
    referralMilestoneBonus: '🎁 Referral milestone reached! You received {bonus} bonus points. Total points: {points}',
    invalidQuantity: '❌ Invalid quantity. Please send a valid positive number.',
    mustJoinChannel: '🔒 Please join our channel first\n\n{message}\n\nThen press the check button.',
    joinChannel: '📢 Join Channel',
    checkSubscription: '🔄 Check Subscription',
    captchaChallenge: '🤖 Human verification\n\nPlease solve: {challenge} = ?',
    captchaSuccess: '✅ Verification successful! Welcome!',
    captchaWrong: '❌ Wrong answer. Try again.',
    setChannelLink: '🔗 Set Channel Link',
    setChannelMessage: '📝 Set Channel Message',
    currentChannelLink: 'Current channel link: {link}',
    currentChannelMessage: 'Current channel message: {message}',
    enterNewChannelLink: 'Send new channel link (e.g., https://t.me/yourchannel or @yourchannel or -100...):',
    enterNewChannelMessage: 'Send new channel message (text):',
    verificationStatus: 'Verification status: {status}',
    verificationEnabled: '✅ Enabled',
    verificationDisabled: '❌ Disabled',
    enableVerification: '✅ Enable mandatory verification',
    disableVerification: '⛔ Disable mandatory verification',
    verificationToggledOn: '✅ Mandatory verification enabled.',
    verificationToggledOff: '⛔ Mandatory verification disabled.',
    verificationNeedsChannel: '❌ Set and resolve the channel first before enabling mandatory verification.',
    channelHelpText: 'You can send @channelusername, -100 chat id, or forward a post from the channel to save it accurately.',
    channelLinkSet: '✅ Channel link updated!',
    channelMessageSet: '✅ Channel message updated!',
    buttonVisibilityUpdated: '✅ Button visibility updated!',
    setIQDRate: '💰 Set IQD Exchange Rate',
    setUSDTWallet: '🏦 Set USDT Wallet Address',
    setIQDWallet: '🏦 Set IQD SuperKey',
    editCurrencyNames: '✏️ Edit Currency Names',
    editDepositInstructions: '📝 Edit Deposit Instructions',
    editUSDName: 'Edit USDT name',
    editIQDName: 'Edit IQD name',
    editUSDInstructions: 'Edit USDT instructions',
    editIQDInstructions: 'Edit IQD instructions',
    enterNewRate: 'Send new exchange rate (1 USD = ? IQD):',
    enterWalletAddress: 'Send wallet address / SuperKey:',
    enterInstructions: 'Send deposit instructions (text):',
    enterNewCurrencyName: 'Send new currency name:',
    manageIQDMethods: 'Manage Iraqi Dinar Methods',
    manageUSDMethods: 'Manage Binance Methods',
    addDepositMethod: 'Add Payment Method',
    deleteDepositMethod: 'Delete Payment Method',
    editDepositTemplates: 'Edit Deposit Messages',
    editIQDTemplateAr: 'Edit IQD Arabic message',
    editIQDTemplateEn: 'Edit IQD English message',
    editUSDTemplateAr: 'Edit Binance Arabic message',
    editUSDTemplateEn: 'Edit Binance English message',
    editIQDNameAr: 'Edit IQD Arabic name',
    editIQDNameEn: 'Edit IQD English name',
    editUSDNameAr: 'Edit Binance Arabic name',
    editUSDNameEn: 'Edit Binance English name',
    enterMethodNameAr: 'Send payment method name in Arabic:',
    enterMethodNameEn: 'Send payment method name in English:',
    enterMethodValue: 'Send payment number / address / account:',
    methodAdded: '✅ Payment method added!',
    methodDeleted: '✅ Payment method deleted!',
    noMethods: 'No payment methods added yet.',
    enterNewTemplate: 'Send the full message template. Use placeholders like {amount}, {amountUSD}, {amountIQD}, {rate}, {methods_block}, {instructions}.',
    currencyNameUpdated: '✅ Currency name updated!',
    walletSet: '✅ Wallet address updated!',
    instructionsSet: '✅ Instructions updated!',
    rateSet: '✅ Exchange rate updated!',
    totalCodes: '📦 Total codes in stock: {count}',
    totalSales: '💰 Total sales: {amount} USD',
    pendingDeposits: '⏳ Pending deposits: {count}',
    sendReply: 'Send your message:',
    supportMessageSent: '📨 Your message has been sent to support. You will receive a reply soon.',
    supportNotification: '📩 New support message\n\nUsername: {username}\nName: {name}\nUser ID: {userId}\n\nMessage: {message}',
    replyToSupport: 'Reply to this user:',
    replyMessage: 'Your reply from support:'
  },
  ar: {
    start: '🌍 اختر اللغة',
    menu: '👋 القائمة الرئيسية:',
    redeem: '🔄 استرداد الكود',
    buy: '🛒 شراء كودات',
    myBalance: '💰 رصيدي',
    deposit: '💳 شحن الرصيد',
    support: '📞 الدعم الفني',
    chooseMerchant: '👋 اختر التاجر:',
    processing: '⏳ جاري المعالجة...',
    enterQty: '✍️ أرسل الكمية:',
    noCodes: '❌ لا يوجد عدد كافٍ من الأكواد في المخزون',
    back: '🔙 رجوع',
    adminPanel: '🔧 لوحة التحكم',
    addMerchant: '➕ إضافة تاجر',
    listMerchants: '📋 قائمة التجار',
    addCodes: '📦 إضافة أكواد',
    stats: '📊 الإحصائيات',
    setPrice: '💰 تعديل السعر',
    setChatgptPrice: '🤖 تعديل سعر كود ChatGPT',
    enterChatgptPrice: 'أرسل سعر كود ChatGPT الجديد بالدولار:',
    chatgptPriceUpdated: '✅ تم تحديث سعر كود ChatGPT إلى {price} دولار!',
    paymentMethods: '💳 طرق الدفع',
    manageBots: '🤖 إدارة البوتات',
    manageMenuButtons: '🎛️ إدارة الأزرار',
    moveUp: '⬆️ رفع',
    moveDown: '⬇️ تنزيل',
    buttonOrderUpdated: '✅ تم تحديث ترتيب الزر!',
    manageChannel: '📢 إدارة القناة المطلوبة',
    manageDepositSettings: '💱 إعدادات الشحن',
    referralSettings: '👥 إعدادات الإحالة',
    manageRedeemServices: '🔄 إدارة خدمات الاسترداد',
    manageDiscountCodes: '🎟️ إدارة كودات الخصم',
    sendAnnouncement: '📢 إرسال إعلان',
    editCodeDeliveryMessage: '✏️ تعديل رسالة تسليم الكود',
    chooseCodeMessageLanguage: 'اختر لغة رسالة الكود:',
    codeMessageArabic: '🇮🇶 رسالة الكود بالعربية',
    codeMessageEnglish: '🇺🇸 رسالة الكود بالإنجليزية',
    enterAnnouncementText: 'أرسل نص الإعلان/التنويه الذي تريد نشره لمستخدمي البوت:',
    announcementSent: '✅ تم إرسال الإعلان. نجح: {sent} | فشل: {failed}',
    enterCodeDeliveryMessage: 'أرسل النص الذي تريد ظهوره قبل الكود. أرسل /empty للحذف.',
    codeDeliveryMessageUpdated: '✅ تم تحديث رسالة تسليم الكود.',
    enterBotToken: 'أرسل توكن البوت:',
    botAdded: '✅ تمت إضافة البوت!',
    botRemoved: '❌ تم حذف البوت!',
    chooseCurrency: '💱 اختر العملة للشحن:',
    currency_usd_name: 'بايننس',
    currency_iqd_name: 'دينار عراقي',
    depositInstructionsUSD: '💰 قم بإرسال {amount} USDT إلى إحدى طرق الدفع التالية:\n\n{methods_block}\n\nثم أرسل صورة التحويل مع أي رسالة.\n\n{instructions}',
    depositInstructionsIQD: '💰 قم بإرسال {amountIQD} دينار عراقي (≈ {amountUSD} دولار بسعر صرف {rate} دينار/دولار) إلى إحدى طرق الدفع التالية:\n\n{methods_block}\n\nثم أرسل صورة التحويل مع أي رسالة.\n\n{instructions}',
    depositProofReceived: '✅ تم استلام إثبات الدفع! سيقوم الأدمن بمراجعته قريباً.',
    depositSuccess: '✅ تم الشحن بنجاح! الرصيد الجديد: {balance} دولار',
    depositRejected: '❌ تم رفض عملية الشحن.',
    depositNotification: '💳 طلب شحن جديد من المستخدم {userId}\nالمبلغ: {amount} {currency}\nطريقة الدفع: {method}\n\nالرسالة: {message}',
    approve: '✅ موافقة',
    reject: '❌ رفض',
    success: '✅ تم الشراء بنجاح! إليك الأكواد:',
    error: '❌ خطأ',
    askMerchantNameEn: 'أرسل اسم التاجر بالإنجليزية:',
    askMerchantNameAr: 'أرسل اسم التاجر بالعربية:',
    askMerchantPrice: 'أرسل السعر بالدولار:',
    askMerchantType: 'اختر نوع التاجر:',
    typeSingle: 'فردي (كود واحد في كل سطر)',
    typeBulk: 'جملة (إيميل وباسورد في سطرين)',
    askDescription: 'أرسل شرح توضيحي (نص، صورة، فيديو، أو /skip):',
    merchantCreated: '✅ تم إنشاء التاجر! المعرف: {id}',
    enterPrice: 'أدخل السعر الجديد (دولار):',
    priceUpdated: '💰 تم تحديث السعر!',
    enterCodes: 'أرسل الأكواد مفصولة بسطور جديدة أو مسافات:',
    codesAdded: '✅ تمت إضافة الأكواد بنجاح!',
    merchantList: '📋 قائمة التجار:\n',
    askCategory: 'أرسل اسم التصنيف:',
    categoryUpdated: 'تم تحديث التصنيف!',
    setReferralPercent: 'أدخل نسبة مكافأة الإحالة:',
    referralPercentUpdated: 'تم تحديث نسبة مكافأة الإحالة إلى {percent}%.',
    showDescription: '📖 عرض الشرح',
    redeemServiceNameEn: 'أرسل اسم الخدمة بالإنجليزية:',
    redeemServiceNameAr: 'أرسل اسم الخدمة بالعربية:',
    redeemServiceMerchantId: 'أرسل معرف التاجر في NodeCard:',
    redeemServicePlatformId: 'أرسل معرف المنصة (افتراضي 1):',
    redeemServiceAdded: '✅ تمت إضافة خدمة الاسترداد!',
    chooseRedeemService: 'اختر الخدمة المراد استرداد الكود فيها:',
    sendCodeToRedeem: 'أرسل الكود المراد استرداده:',
    redeemSuccess: '✅ تم استرداد البطاقة بنجاح!\n\n💳 تفاصيل البطاقة:\n{details}',
    redeemFailed: '❌ فشل استرداد البطاقة: {reason}',
    listRedeemServices: '📋 قائمة خدمات الاسترداد',
    addRedeemService: '➕ إضافة خدمة استرداد',
    deleteRedeemService: '🗑️ حذف خدمة استرداد',
    listDiscountCodes: '📋 قائمة كودات الخصم',
    addDiscountCode: '➕ إضافة كود خصم',
    deleteDiscountCode: '🗑️ حذف كود خصم',
    enterDiscountCodeValue: 'أدخل كود الخصم:',
    enterDiscountPercent: 'أدخل نسبة الخصم:',
    enterDiscountValidUntil: 'أدخل تاريخ الانتهاء (YYYY-MM-DD) أو /skip:',
    enterDiscountMaxUses: 'أدخل الحد الأقصى للاستخدام:',
    discountCodeAdded: '✅ تمت إضافة كود الخصم!',
    discountCodeDeleted: '❌ تم حذف كود الخصم!',
    noDiscountCodes: 'لا توجد كودات خصم.',
    enterDiscountCode: 'أرسل كود الخصم الخاص بك:',
    discountApplied: '✅ تم تطبيق كود الخصم! تحصل على خصم {percent}%.',
    discountInvalid: '❌ كود خصم غير صالح أو منتهي الصلاحية.',
    myPurchases: '📜 مشترياتي',
    noPurchases: 'لا توجد مشتريات بعد.',
    purchaseHistory: '🛍️ سجل المشتريات:\n{history}',
    confirmDelete: '⚠️ هل أنت متأكد من حذف هذا التاجر؟',
    yes: '✅ نعم',
    no: '❌ لا',
    merchantDeleted: 'تم حذف التاجر بنجاح.',
    referral: '🤝 دعوة الأصدقاء',
    redeemPoints: '🎁 استبدال النقاط',
    getFreeCode: '🎁 احصل على كودك المجاني',
    freeCodeMenu: '🎁 احصل على كودك المجاني',
    referralInfo: 'شارك رابط الإحالة الخاص بك مع أصدقائك واربح نقطة واحدة لكل إحالة ناجحة!\n\nرابطك:\n{link}\n\nنقاطك: {points}\n🎁 استبدل {requiredPoints} نقاط للحصول على كود ChatGPT مجاناً!',
    referralEarned: '🎉 لقد ربحت نقطة إحالة! إجمالي النقاط: {points}',
    notEnoughPoints: '❌ لا تملك نقاطًا كافية. لديك {points} نقطة، وكل كود يحتاج {requiredPoints} نقاط.',
    redeemPointsAskAmount: 'أرسل عدد كودات ChatGPT التي تريد أخذها بالنقاط. كل كود يحتاج {requiredPoints} نقاط.',
    redeemPointsInvalidAmount: '❌ العدد غير صالح. أرسل عددًا موجبًا صحيحًا من الكودات.',
    pointsRedeemed: '✅ تم استبدال النقاط بنجاح! إليك كودات ChatGPT GO:\n\n{code}',
    setRedeemPoints: '🎁 تعيين نقاط الاستبدال',
    enterRedeemPoints: 'أدخل عدد النقاط المطلوبة للحصول على كود ChatGPT مجاني:',
    redeemPointsUpdated: '✅ تم تحديث نقاط الاستبدال إلى {points}.',
    grantPoints: '🎁 منح نقاط',
    enterGrantPointsUserId: 'أرسل آيدي المستخدم في تيليجرام:',
    enterGrantPointsAmount: 'أرسل عدد النقاط المراد منحها:',
    grantPointsUserNotFound: '❌ المستخدم غير موجود.',
    grantPointsDone: '✅ تم إضافة {points} نقطة للمستخدم {userId}. المجموع الجديد: {total}',
    pointsGrantedNotification: '🎁 لقد حصلت على {points} نقطة إحالة من الأدمن. مجموع نقاطك الآن: {total}',
    setFreeCodeDays: '⏳ تعيين مدة ظهور الكود المجاني',
    enterFreeCodeDays: 'أرسل عدد الأيام التي بعدها يظهر زر الكود المجاني مرة أخرى:',
    freeCodeDaysUpdated: '✅ تم تحديث مدة ظهور الكود المجاني إلى {days} يوم.',
    currentRedeemPoints: 'عدد النقاط المطلوبة حالياً: {points}',
    currentReferralPercent: 'نسبة مكافأة الإحالة الحالية: {percent}%',
    currentFreeCodeDays: 'مدة ظهور الكود المجاني: {days} يوم',
    grantCreatorDiscount: '🎟️ منح خصم لصانع محتوى',
    editReferralMilestones: '🎯 تعديل مكافآت الإحالة المرحلية',
    enterReferralMilestones: 'أرسل مكافآت الإحالة بهذا الشكل:\n15:5,40:5,80:10,150:30',
    referralMilestonesUpdated: '✅ تم تحديث مكافآت الإحالة المرحلية.',
    currentReferralMilestones: 'مكافآت الإحالة المرحلية الحالية: {milestones}',
    referralEligibleUsers: '🎁 المؤهلون لهدية الإحالة',
    deductReferralPoints: '➖ خصم نقاط',
    referralStockSettings: '📦 مخزون ChatGPT الإحالات',
    referralStockClaim: '🎁 جائزة الإحالات',
    noReferralEligibleUsers: 'لا يوجد حاليًا مستخدمون لديهم إحالات سابقة ورصيد قابل لتعويض الإحالات.',
    referralEligibleUsersTitle: 'المستخدمون المؤهلون:',
    referralEligibleUserLine: 'الاسم: {name}\nالمعرف: {username}\nالايدي: {id}\nإجمالي النقاط: {points}\nتم منحه من الأدمن: {adminGranted}\nعدد الإحالات: {referrals}\nجوائز الإحالات المرحلية: {milestoneRewards}\nتم سحب كودات سابقًا: {claimedCodes}\nالمتاح الآن: {redeemableCodes}',
    referralClaimAdminNotice: '🎁 تم سحب كود من تعويض الإحالات\nبواسطة: {name}\nالمعرف: {username}\nالايدي: {id}\nسحب الآن: {claimedNow}\nسحب سابقًا: {claimedBefore}\nإجمالي ما سحبه بعد العملية: {claimedAfter}\nالمستحق الآن بعد السحب: {eligibleNow}\nنقاطه الحالية: {points}\nتم منحه من الأدمن: {adminGranted}\nعدد إحالاته: {referrals}\nجوائز الإحالات المرحلية: {milestoneRewards}',
    referralStockAccessDenied: '❌ هذا المخزون مخصص فقط للأشخاص الذين لديهم إحالات ناجحة سابقة.',
    enterDeductPointsUserId: 'أرسل آيدي المستخدم الذي تريد خصم نقاطه:',
    enterDeductPointsAmount: 'أرسل عدد النقاط المراد خصمها:',
    deductPointsDone: '✅ تم خصم النقاط. المستخدم {userId} لديه الآن {points} نقطة.',
    deductPointsUserNotFound: '❌ المستخدم غير موجود.',
    toggleReferrals: '🔁 إيقاف/تشغيل الإحالات',
    referralsEnabledStatus: '✅ احتساب الإحالات مفعل',
    referralsDisabledStatus: '⛔ احتساب الإحالات متوقف',
    referralsTurnedOn: '✅ تم تفعيل الإحالات.',
    referralsTurnedOff: '⛔ تم إيقاف الإحالات.',
    addReferralStockCodes: '➕ إضافة أكواد لمخزون الإحالات',
    viewReferralStockCount: '📦 عرض مخزون الإحالات',
    referralStockCountText: 'مخزون ChatGPT الإحالات: {count} كود.',
    enterReferralStockCodes: 'أرسل أكواد مخزون ChatGPT الإحالات مفصولة بأسطر جديدة أو مسافات:',
    referralStockCodesAdded: '✅ تمت إضافة أكواد مخزون الإحالات.',
    referralStockNotEnough: '❌ لا يوجد عدد كافٍ في مخزون ChatGPT الإحالات لهذا الطلب.',
    referralStockNoCodesAvailable: '❌ لا يوجد حاليًا مخزون ChatGPT إحالات متاح.',
    referralClaimAskCount: 'أرسل عدد كودات مخزون الإحالات التي تريد استلامها. المتاح حسب نقاطك: {maxCodes}.',
    botAllowedUsers: '👤 المستخدمون المسموح لهم أثناء إيقاف البوت',
    balanceManagement: '💰 إدارة الرصيد',
    usersWithBalance: '👥 أصحاب الرصيد',
    addBalanceAdmin: '➕ إضافة رصيد',
    deductBalanceAdmin: '➖ سحب رصيد',
    enterBalanceUserId: 'أرسل آيدي المستخدم:',
    enterBalanceAmount: 'أرسل مبلغ الرصيد بالدولار:',
    usersWithBalanceTitle: 'المستخدمون الذين لديهم رصيد:',
    noUsersWithBalance: 'لا يوجد حاليًا مستخدمون لديهم رصيد أكبر من 0.',
    balanceUserLine: 'الاسم: {name}\nالمعرف: {username}\nالايدي: {id}\nالرصيد: {balance} دولار',
    balanceUserNotFound: '❌ المستخدم غير موجود.',
    balanceAmountInvalid: '❌ مبلغ الرصيد غير صالح.',
    balanceAddedDone: '✅ تمت إضافة {amount} دولار إلى المستخدم {userId}. الرصيد الجديد: {balance} دولار',
    balanceDeductedDone: '✅ تم سحب {amount} دولار من المستخدم {userId}. الرصيد الجديد: {balance} دولار',
    balanceReceivedNotification: '💰 تمت إضافة {amount} دولار إلى رصيدك. الرصيد الجديد: {balance} دولار',
    balanceDeductedNotification: '💰 تم سحب {amount} دولار من رصيدك. الرصيد الجديد: {balance} دولار',
    stockClaimAdminShort: '📦 تم السحب من المخزون\nالاسم: {name}\nالمعرف: {username}\nالايدي: {id}\nالعدد: {count}',
    balancePurchaseAdminNotice: '💳 شراء بواسطة الرصيد\nالاسم: {name}\nالمعرف: {username}\nالايدي: {id}\nالتاجر: {merchant}\nالكمية: {qty}\nالإجمالي: {total} دولار',
    enterAllowedUsers: 'أرسل آيديات تيليجرام المسموح لهم مفصولة بفواصل أو مسافات أو أسطر. أرسل /empty للحذف.',
    allowedUsersUpdated: '✅ تم تحديث المستخدمين المسموح لهم.',
    currentAllowedUsers: 'الآيديات المسموح لها حاليًا: {ids}',
    quantityDiscountSettings: '💸 إعدادات خصم الكمية',
    setBulkDiscountThreshold: '📦 تعيين كمية الخصم',
    setBulkDiscountPrice: '💵 تعيين السعر بعد الخصم',
    enterBulkDiscountThreshold: 'أرسل الكمية التي يبدأ عندها الخصم:',
    enterBulkDiscountPrice: 'أرسل سعر الكود بعد الخصم بالدولار:',
    currentBulkDiscountThreshold: 'يبدأ الخصم من كمية: {threshold}',
    currentBulkDiscountPrice: 'السعر بعد الخصم: {price} دولار لكل كود',
    quantityDiscountSettingsText: '💸 إعدادات خصم الكمية\n\n{thresholdLine}\n{priceLine}',
    bulkDiscountSettingsUpdated: '✅ تم تحديث إعدادات خصم الكمية.',
    botControl: '🤖 التحكم بالبوت',
    botStatusLine: 'حالة البوت الحالية: {status}',
    botEnabledStatus: '✅ يعمل',
    botDisabledStatus: '⛔ متوقف',
    enableBot: '✅ تشغيل البوت',
    disableBot: '⛔ إيقاف البوت',
    botTurnedOn: '✅ تم تشغيل البوت للمستخدمين.',
    botTurnedOff: '⛔ تم إيقاف البوت للمستخدمين.',
    botPausedMessage: '⛔ البوت متوقف مؤقتًا. حاول لاحقًا.',
    depositReminderPending: '⏰ تذكير بوجود طلب شحن معلق\nايدي المستخدم: {userId}\nالمبلغ: {amount} {currency}',
    grantPointsDoneDetailed: '✅ تم منح النقاط بنجاح.\n\nايدي المستخدم: {userId}\nالمعرف: {username}\nالاسم: {name}\nتم منحه الآن: {points}\nإجمالي نقاطه: {total}\nإجمالي ما منحه الأدمن: {adminGranted}\nعدد إحالاته: {referrals}\nنقاط جوائز الإحالات: {milestoneRewards}',
    enterCreatorDiscountUserId: 'أرسل آيدي صانع المحتوى:',
    enterCreatorDiscountPercent: 'أرسل نسبة الخصم لاستبدال النقاط (من 0 إلى 100):',
    creatorDiscountUserNotFound: '❌ المستخدم غير موجود.',
    creatorDiscountUpdated: '✅ تم تحديث خصم المستخدم {userId} إلى {percent}%. عدد النقاط المطلوب الآن لكل كود: {requiredPoints}.',
    creatorDiscountGrantedNotification: '🎟️ تم منحك خصم صانع محتوى بنسبة {percent}%. عدد النقاط المطلوب لكل كود أصبح {requiredPoints}.',
    currentCreatorDiscount: 'خصم صانع المحتوى الخاص بك: {percent}%',
    manageReferralSettingsText: '👥 إعدادات الإحالة\n\n{percentLine}\n{pointsLine}\n{freeCodeDaysLine}\n{milestonesLine}\n{referralsStatusLine}',
    chatgptCode: 'GPT',
    productsSection: '📦 قسم المنتجات',
    addProductSection: '➕ إضافة قسم',
    manageProductSections: '📚 إدارة الأقسام',
    enterSectionNameEn: 'أرسل اسم القسم بالإنجليزية:',
    enterSectionNameAr: 'أرسل اسم القسم بالعربية:',
    sectionAdded: '✅ تمت إضافة القسم بنجاح.',
    productSectionsTitle: '📚 أقسام المنتجات:',
    noProductSections: 'لا توجد أقسام.',
    manageSection: '📂 إدارة القسم',
    renameSection: '✏️ تعديل اسم القسم',
    deleteSection: '🗑️ حذف القسم',
    sectionDeleted: '✅ تم حذف القسم.',
    cannotDeleteGptSection: '❌ لا يمكن حذف قسم GPT.',
    addSectionProduct: '➕ إضافة منتج داخل القسم',
    manageSectionProducts: '📋 إدارة منتجات القسم',
    sectionManageText: 'إدارة القسم: {name}',
    sectionChooseText: 'اختر منتجًا من هذا القسم:',
    noSectionProducts: '❌ هذا القسم لا يحتوي منتجات بعد.',
    setSectionName: '✏️ تعيين اسم القسم',
    sectionNameUpdated: '✅ تم تحديث اسم القسم.',
    sectionProductsTitle: 'منتجات القسم {name}:',
    manageProductInline: '⚙️ إدارة المنتج',
    renameProduct: '✏️ تعديل اسم المنتج',
    deleteProduct: '🗑️ حذف المنتج',
    productDeleted: '✅ تم حذف المنتج.',
    chooseProductNameLanguage: 'اختر الاسم الذي تريد تعديله:',
    editNameArabic: '🇮🇶 الاسم العربي',
    editNameEnglish: '🇺🇸 الاسم الإنجليزي',
    enterProductName: 'أرسل الاسم الجديد للمنتج:',
    productUpdated: '✅ تم تحديث المنتج.',
    showOnHome: '📌 إظهار في الواجهة',
    hideFromHome: '🚫 إخفاء من الواجهة',
    featuredUpdated: '✅ تم تحديث ظهور المنتج في الواجهة.',
    sectionButtonManageInfo: 'هذا القسم يظهر في الواجهة الرئيسية. من هنا تستطيع تعديل اسمه، إضافة منتجات، إدارة المنتجات، أو حذف القسم.',
    typeCodeSingle: 'كود',
    typeAccountSingle: 'إيميل وباسورد',
    typeAccountVerifySingle: 'إيميل وباسورد وتحقق',
    typeAccountBulk: 'جملة إيميل وباسورد',
    typeAccountVerifyBulk: 'جملة إيميل وباسورد وتحقق',
    stockFormatCode: 'أرسل المخزون بحيث كل سطر = كود واحد.',
    stockFormatAccount: 'أرسل المخزون على شكل زوجين:\nإيميل\nباسورد',
    stockFormatAccountVerify: 'أرسل المخزون على شكل 3 أسطر لكل منتج:\nإيميل\nباسورد\nتحقق',
    askEmail: 'يرجى إدخال بريدك الإلكتروني:',
    freeCodeSuccess: '🎉 إليك كود ChatGPT GO المجاني:\n\n{code}',
    alreadyGotFree: 'لقد حصلت بالفعل على كودك المجاني. يمكنك شراء أكواد إضافية.',
    askQuantity: 'كم عدد أكواد ChatGPT التي تريد شراءها؟ أرسل الرقم فقط.',
    enterEmailForPurchase: 'أدخل بريدك الإلكتروني لاستلام الكود:',
    purchaseSuccess: '✅ تم الشراء بنجاح! إليك كودات ChatGPT GO:\n\n{code}',
    insufficientBalance: '❌ رصيد غير كاف. رصيدك: {balance} دولار. سعر الكود: {price} دولار\n\nتحتاج إلى: {needed} دولار كي يمكنك الحصول على هذا العدد من الكودات',
    depositNow: '💳 شحن الرصيد',
    bulkDiscountInfo: '🔥 خصم على الكمية: إذا اشتريت {threshold} كودًا أو أكثر يصبح سعر الكود الواحد {price} دولار.',
    referralMilestoneBonus: '🎁 تم تحقيق مستوى إحالة جديد! حصلت على {bonus} نقاط إضافية. مجموع نقاطك الآن: {points}',
    invalidQuantity: '❌ كمية غير صالحة. يرجى إرسال رقمًا موجبًا صحيحًا.',
    mustJoinChannel: '🔒 يرجى الاشتراك في القناة أولاً\n\n{message}\n\nثم اضغط زر التحقق.',
    joinChannel: '📢 اشترك الآن',
    checkSubscription: '🔄 تحقق من الاشتراك',
    captchaChallenge: '🤖 التحقق البشري\n\nيرجى حل: {challenge} = ?',
    captchaSuccess: '✅ تم التحقق بنجاح! أهلاً بك!',
    captchaWrong: '❌ إجابة خاطئة. حاول مرة أخرى.',
    setChannelLink: '🔗 تعيين رابط القناة',
    setChannelMessage: '📝 تعيين نص رسالة القناة',
    currentChannelLink: 'رابط القناة الحالي: {link}',
    currentChannelMessage: 'نص الرسالة الحالي: {message}',
    enterNewChannelLink: 'أرسل رابط القناة الجديد (مثال: https://t.me/yourchannel أو @yourchannel أو -100...):',
    enterNewChannelMessage: 'أرسل نص رسالة القناة الجديد:',
    verificationStatus: 'حالة التحقق الإجباري: {status}',
    verificationEnabled: '✅ مفعل',
    verificationDisabled: '❌ متوقف',
    enableVerification: '✅ تفعيل التحقق الإجباري',
    disableVerification: '⛔ إيقاف التحقق الإجباري',
    verificationToggledOn: '✅ تم تفعيل التحقق الإجباري.',
    verificationToggledOff: '⛔ تم إيقاف التحقق الإجباري.',
    verificationNeedsChannel: '❌ يجب ضبط القناة وحفظها بشكل صحيح قبل تفعيل التحقق الإجباري.',
    channelHelpText: 'يمكنك إرسال @channelusername أو معرّف القناة الذي يبدأ بـ -100 أو إعادة توجيه منشور من القناة ليتم حفظها بدقة.',
    channelLinkSet: '✅ تم تحديث رابط القناة!',
    channelMessageSet: '✅ تم تحديث نص الرسالة!',
    buttonVisibilityUpdated: '✅ تم تحديث ظهور الأزرار!',
    setIQDRate: '💰 تعيين سعر صرف الدينار',
    setUSDTWallet: '🏦 تعيين عنوان محفظة USDT',
    setIQDWallet: '🏦 تعيين السوبر كي للدينار',
    editCurrencyNames: '✏️ تعديل أسماء العملات',
    editDepositInstructions: '📝 تعديل تعليمات الدفع',
    editUSDName: 'تعديل اسم USDT',
    editIQDName: 'تعديل اسم الدينار العراقي',
    editUSDInstructions: 'تعديل تعليمات USDT',
    editIQDInstructions: 'تعديل تعليمات الدينار',
    enterNewRate: 'أرسل سعر الصرف الجديد (1 دولار = ? دينار):',
    enterWalletAddress: 'أرسل عنوان المحفظة / السوبر كي:',
    enterInstructions: 'أرسل تعليمات الدفع:',
    enterNewCurrencyName: 'أرسل الاسم الجديد للعملة:',
    currencyNameUpdated: '✅ تم تحديث اسم العملة!',
    walletSet: '✅ تم تحديث عنوان المحفظة!',
    instructionsSet: '✅ تم تحديث التعليمات!',
    rateSet: '✅ تم تحديث سعر الصرف!',
    totalCodes: '📦 إجمالي الأكواد في المخزون: {count}',
    totalSales: '💰 إجمالي المبيعات: {amount} دولار',
    pendingDeposits: '⏳ شحنات معلقة: {count}',
    sendReply: 'أرسل رسالتك:',
    supportMessageSent: '📨 تم إرسال رسالتك إلى الدعم الفني. ستتلقى رداً قريباً.',
    supportNotification: '📩 رسالة دعم جديدة\n\nالمعرف: {username}\nالاسم: {name}\nايدي المستخدم: {userId}\n\nالرسالة: {message}',
    replyToSupport: 'رد على هذا المستخدم:',
    replyMessage: 'ردك من الدعم الفني:'
  }
};

function isAdmin(userId) {
  return Number(userId) === ADMIN_ID;
}

function safeParseState(value) {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

async function setUserState(userId, state) {
  await User.update({ state: JSON.stringify(state) }, { where: { id: userId } });
}

async function clearUserState(userId) {
  await User.update({ state: null }, { where: { id: userId } });
}

function generateReferralCode(userId) {
  return `REF${userId}`;
}

function generateRandomEmail() {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let localPart = '';
  for (let i = 0; i < 10; i += 1) {
    localPart += chars[Math.floor(Math.random() * chars.length)];
  }
  return `${localPart}@gmail.com`;
}

async function getText(userId, key, replacements = {}) {
  try {
    const user = await User.findByPk(userId);
    const lang = user ? user.lang : 'en';
    const setting = await Setting.findOne({ where: { key, lang } });
    let text = setting ? setting.value : DEFAULT_TEXTS[lang]?.[key];

    if (!text) {
      text = DEFAULT_TEXTS.en?.[key] || key;
    }

    for (const [k, v] of Object.entries(replacements)) {
      text = text.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v));
    }
    return text;
  } catch (err) {
    console.error('Error in getText:', err);
    return DEFAULT_TEXTS.en?.[key] || key;
  }
}

async function getGlobalSetting(key, defaultValue) {
  const setting = await Setting.findOne({ where: { key, lang: 'global' } });
  if (!setting) return defaultValue;
  return setting.value;
}


function slugifySectionKey(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '') || `section_${Date.now()}`;
}

function getDefaultProductSections() {
  return [
    { key: 'gpt', nameEn: 'GPT', nameAr: 'GPT', isSystem: true }
  ];
}

async function getProductSections() {
  const raw = await getGlobalSetting('product_sections', '');
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.length) {
      const list = parsed.map(s => ({
        key: String(s.key || '').trim(),
        nameEn: String(s.nameEn || '').trim() || String(s.key || '').trim(),
        nameAr: String(s.nameAr || '').trim() || String(s.nameEn || '').trim() || String(s.key || '').trim(),
        isSystem: Boolean(s.isSystem)
      })).filter(s => s.key);
      if (!list.find(s => s.key === 'gpt')) {
        list.unshift(getDefaultProductSections()[0]);
      }
      return list;
    }
  } catch {}
  return getDefaultProductSections();
}

async function saveProductSections(sections) {
  await Setting.upsert({
    key: 'product_sections',
    lang: 'global',
    value: JSON.stringify(sections)
  });
}

async function addProductSection(nameEn, nameAr) {
  const sections = await getProductSections();
  let key = slugifySectionKey(nameEn || nameAr);
  let counter = 2;
  while (sections.find(s => s.key === key)) {
    key = `${slugifySectionKey(nameEn || nameAr)}_${counter}`;
    counter += 1;
  }
  sections.push({ key, nameEn: nameEn || key, nameAr: nameAr || nameEn || key, isSystem: false });
  await saveProductSections(sections);
  return key;
}

async function updateProductSection(key, patch = {}) {
  const sections = await getProductSections();
  const updated = sections.map(s => s.key === key ? { ...s, ...patch } : s);
  await saveProductSections(updated);
}

async function deleteProductSectionByKey(key) {
  const sections = await getProductSections();
  const section = sections.find(s => s.key === key);
  if (!section || section.key === 'gpt') return false;
  await Merchant.update({ category: 'general' }, { where: { category: key } });
  await saveProductSections(sections.filter(s => s.key !== key));
  const featuredMap = await getFeaturedProductsMap();
  delete featuredMap[key];
  await saveFeaturedProductsMap(featuredMap);
  return true;
}

async function getProductSectionByKey(key) {
  return (await getProductSections()).find(s => s.key === key) || null;
}

async function getLocalizedSectionName(userId, section) {
  const lang = (await User.findByPk(userId))?.lang || 'en';
  return lang === 'ar' ? (section.nameAr || section.nameEn) : (section.nameEn || section.nameAr);
}

async function getFeaturedProductsMap() {
  const raw = await getGlobalSetting('featured_products_map', '{}');
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

async function saveFeaturedProductsMap(map) {
  await Setting.upsert({
    key: 'featured_products_map',
    lang: 'global',
    value: JSON.stringify(map || {})
  });
}

async function getFeaturedProductIdsForSection(sectionKey) {
  const map = await getFeaturedProductsMap();
  return Array.isArray(map[sectionKey]) ? map[sectionKey].map(v => parseInt(v, 10)).filter(Boolean) : [];
}

async function isProductFeaturedOnHome(sectionKey, merchantId) {
  const ids = await getFeaturedProductIdsForSection(sectionKey);
  return ids.includes(Number(merchantId));
}

async function toggleFeaturedProduct(sectionKey, merchantId) {
  const map = await getFeaturedProductsMap();
  const current = Array.isArray(map[sectionKey]) ? map[sectionKey].map(v => parseInt(v, 10)).filter(Boolean) : [];
  const id = Number(merchantId);
  map[sectionKey] = current.includes(id) ? current.filter(v => v !== id) : [...current, id];
  await saveFeaturedProductsMap(map);
  return map[sectionKey].includes(id);
}

function getMerchantDedupeKey(merchant) {
  return [
    String(merchant?.category || '').trim().toLowerCase(),
    String(merchant?.nameEn || '').trim().toLowerCase(),
    String(merchant?.nameAr || '').trim().toLowerCase(),
    Number(merchant?.price || 0).toFixed(2),
    String(merchant?.type || '').trim().toLowerCase()
  ].join('|');
}

function dedupeMerchants(merchants) {
  const seen = new Set();
  const out = [];
  for (const merchant of merchants) {
    const key = getMerchantDedupeKey(merchant);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(merchant);
  }
  return out;
}

async function getMerchantsBySection(sectionKey) {
  if (sectionKey === 'gpt') {
    return dedupeMerchants(await Merchant.findAll({
      where: {
        [Op.or]: [
          { category: 'gpt' },
          { category: 'ChatGPT' },
          { category: 'chatgpt' },
          { category: 'AI Services' },
          { nameEn: 'ChatGPT Code' }
        ]
      },
      order: [['id', 'ASC']]
    }));
  }
  return dedupeMerchants(await Merchant.findAll({ where: { category: sectionKey }, order: [['id', 'ASC']] }));
}

async function showFrontSection(userId, sectionKey) {
  const section = await getProductSectionByKey(sectionKey);
  if (!section) {
    await bot.sendMessage(userId, await getText(userId, 'error'));
    return;
  }

  const merchants = await getMerchantsBySection(sectionKey);
  const keyboard = [];

  if (sectionKey === 'gpt') {
    const chatgptMerchant = await getOrCreateChatGptMerchant();
    keyboard.push([{
      text: `${await getText(userId, 'chatgptCode')} ($${Number(chatgptMerchant.price || 0).toFixed(2)})`,
      callback_data: 'chatgpt_direct_buy'
    }]);
  }

  if (!merchants.length && sectionKey !== 'gpt') {
    await bot.sendMessage(userId, await getText(userId, 'noSectionProducts'));
    return;
  }

  for (const merchant of merchants) {
    if (sectionKey === 'gpt' && String(merchant.nameEn || '').trim() === 'ChatGPT Code') {
      continue;
    }
    const label = `${await getLocalizedMerchantName(userId, merchant)} ($${Number(merchant.price || 0).toFixed(2)})`;
    keyboard.push([{ text: label, callback_data: `buy_merchant_${merchant.id}` }]);
  }

  if (keyboard.length === 0) {
    await bot.sendMessage(userId, await getText(userId, 'noSectionProducts'));
    return;
  }

  if (isAdmin(userId)) {
    keyboard.push([{ text: await getText(userId, 'manageSection'), callback_data: `admin_manage_section_${sectionKey}` }]);
  }
  keyboard.push([{ text: await getText(userId, 'back'), callback_data: 'back_to_menu' }]);
  await bot.sendMessage(userId, `${await getLocalizedSectionName(userId, section)}

${await getText(userId, 'sectionChooseText')}`, {
    reply_markup: { inline_keyboard: keyboard }
  });
}

async function showAdminProductsSection(userId) {
  const sections = await getProductSections();
  const keyboard = [
    [{ text: await getText(userId, 'addProductSection'), callback_data: 'admin_add_product_section' }],
    [{ text: await getText(userId, 'manageProductSections'), callback_data: 'admin_manage_product_sections' }],
    [{ text: await getText(userId, 'back'), callback_data: 'admin' }]
  ];
  for (const section of sections) {
    keyboard.splice(Math.max(0, keyboard.length - 1), 0, [{ text: `📂 ${await getLocalizedSectionName(userId, section)}`, callback_data: `admin_manage_section_${section.key}` }]);
  }
  await bot.sendMessage(userId, await getText(userId, 'productsSection'), {
    reply_markup: { inline_keyboard: keyboard }
  });
}

async function showSectionAdmin(userId, sectionKey) {
  const section = await getProductSectionByKey(sectionKey);
  if (!section) {
    await bot.sendMessage(userId, await getText(userId, 'error'));
    return;
  }
  const keyboard = [
    [{ text: await getText(userId, 'renameSection'), callback_data: `admin_rename_section_${sectionKey}` }],
    [{ text: await getText(userId, 'addSectionProduct'), callback_data: `admin_section_add_product_${sectionKey}` }],
    [{ text: await getText(userId, 'manageSectionProducts'), callback_data: `admin_section_manage_products_${sectionKey}` }],
  ];
  if (sectionKey !== 'gpt') {
    keyboard.push([{ text: await getText(userId, 'deleteSection'), callback_data: `admin_delete_section_${sectionKey}` }]);
  }
  keyboard.push([{ text: await getText(userId, 'back'), callback_data: 'admin_section_products' }]);
  await bot.sendMessage(userId, `${await getText(userId, 'sectionManageText', { name: await getLocalizedSectionName(userId, section) })}

${await getText(userId, 'sectionButtonManageInfo')}`, {
    reply_markup: { inline_keyboard: keyboard }
  });
}

async function showSectionProductsAdmin(userId, sectionKey) {
  const section = await getProductSectionByKey(sectionKey);
  if (!section) {
    await bot.sendMessage(userId, await getText(userId, 'error'));
    return;
  }
  const merchants = await getMerchantsBySection(sectionKey);
  if (!merchants.length) {
    await bot.sendMessage(userId, await getText(userId, 'noSectionProducts'));
    return;
  }
  for (const merchant of merchants) {
    const featured = await isProductFeaturedOnHome(sectionKey, merchant.id);
    await bot.sendMessage(userId,
      `${await getText(userId, 'sectionProductsTitle', { name: await getLocalizedSectionName(userId, section) })}

${await getLocalizedMerchantName(userId, merchant)} ($${Number(merchant.price || 0).toFixed(2)})
ID: ${merchant.id}
Type: ${merchant.type}${featured ? '\n📌 Featured on home' : ''}`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: await getText(userId, 'setPrice'), callback_data: `set_price_merchant_${merchant.id}` }],
            [{ text: await getText(userId, 'addCodes'), callback_data: `add_codes_merchant_${merchant.id}` }],
            [{ text: await getText(userId, 'renameProduct'), callback_data: `admin_rename_product_${merchant.id}` }],
            [{ text: featured ? await getText(userId, 'hideFromHome') : await getText(userId, 'showOnHome'), callback_data: `admin_toggle_feature_${sectionKey}_${merchant.id}` }],
            [{ text: await getText(userId, 'deleteProduct'), callback_data: `admin_delete_product_${merchant.id}` }]
          ]
        }
      }
    );
  }
}

async function getCodeDeliveryMessage(userId) {
  const user = await User.findByPk(userId);
  const lang = user?.lang || 'en';
  const setting = await Setting.findOne({ where: { key: 'code_delivery_message', lang } });
  return setting?.value || '';
}

async function getCodeDeliveryPrefixHtml(userId) {
  const customMessage = String(await getCodeDeliveryMessage(userId) || '').trim();
  if (!customMessage) return '';
  return `${escapeHtml(customMessage)}\n\n`;
}

async function broadcastAnnouncement(messageText) {
  const users = await User.findAll({ attributes: ['id'] });
  let sent = 0;
  let failed = 0;

  for (const u of users) {
    try {
      await bot.sendMessage(u.id, messageText);
      sent += 1;
    } catch {
      failed += 1;
    }
  }

  return { sent, failed };
}

async function getReferralPercent() {
  const rawValue = await getGlobalSetting('referral_percent', process.env.REFERRAL_PERCENT || '10');
  const value = parseFloat(rawValue);
  return Number.isFinite(value) && value >= 0 ? value : 10;
}

async function getReferralRedeemPoints() {
  const rawValue = await getGlobalSetting('referral_redeem_points', '10');
  const value = parseInt(rawValue, 10);
  return Number.isInteger(value) && value > 0 ? value : 10;
}

async function getFreeCodeCooldownDays() {
  const rawValue = await getGlobalSetting('free_code_cooldown_days', '5');
  const value = parseInt(rawValue, 10);
  return Number.isInteger(value) && value > 0 ? value : 5;
}

async function getBotEnabled() {
  const rawValue = await getGlobalSetting('bot_enabled', 'true');
  return String(rawValue).toLowerCase() !== 'false';
}

async function getAllowedUserIds() {
  const rawValue = await getGlobalSetting('bot_allowed_user_ids', '');
  return String(rawValue || '')
    .split(/[\s,]+/)
    .map(v => parseInt(v, 10))
    .filter(v => Number.isInteger(v) && v > 0);
}

async function isUserAllowedWhenBotStopped(userId) {
  if (isAdmin(userId)) return true;
  const ids = await getAllowedUserIds();
  return ids.includes(Number(userId));
}

async function getReferralEnabled() {
  const rawValue = await getGlobalSetting('referral_enabled', 'true');
  return String(rawValue).toLowerCase() !== 'false';
}

async function getReferralStockMerchant() {
  let merchant = await Merchant.findOne({ where: { nameEn: 'ChatGPT Referral Stock' } });
  if (!merchant) {
    merchant = await Merchant.create({
      nameEn: 'ChatGPT Referral Stock',
      nameAr: 'مخزون ChatGPT الإحالات',
      price: 0,
      category: 'gpt',
      type: 'single',
      description: { type: 'text', content: 'Referral-only ChatGPT stock' }
    });
  }
  return merchant;
}

async function getSuccessfulReferralCount(userId) {
  return await User.count({ where: { referredBy: userId, referralRewarded: true } });
}

async function getRedeemableReferralCodesCount(userId) {
  const user = await User.findByPk(userId);
  if (!user) return 0;
  const referralCount = await getSuccessfulReferralCount(userId);
  if (referralCount <= 0) return 0;
  const requiredPoints = await getEffectiveRedeemPointsForUser(userId);
  return Math.floor(Number(user.referralPoints || 0) / requiredPoints);
}

async function getEligibleReferralUsers(minReferrals = 1) {
  const result = [];
  for (const user of await User.findAll({ order: [['referralPoints', 'DESC'], ['id', 'ASC']] })) {
    const referralCount = await getSuccessfulReferralCount(user.id);
    const requiredPoints = await getEffectiveRedeemPointsForUser(user.id);
    const redeemableCodes = referralCount > 0 ? Math.floor(Number(user.referralPoints || 0) / requiredPoints) : 0;
    if (referralCount >= minReferrals && redeemableCodes > 0) {
      result.push({
        user,
        referralCount,
        redeemableCodes,
        adminGranted: Number(user.adminGrantedPoints || 0),
        totalPoints: Number(user.referralPoints || 0),
        milestoneRewards: Number(user.referralMilestoneGrantedPoints || 0),
        claimedCodes: Number(user.referralStockClaimedCodes || 0)
      });
    }
  }
  return result;
}

async function claimReferralStockCodes(userId, requestedCodes) {
  const user = await User.findByPk(userId);
  if (!user) return { success: false, reason: 'User not found' };

  const referralCount = await getSuccessfulReferralCount(userId);
  if (referralCount <= 0) {
    return { success: false, reason: 'no_referrals' };
  }

  const requiredPoints = await getEffectiveRedeemPointsForUser(userId);
  const maxCodes = Math.floor(Number(user.referralPoints || 0) / requiredPoints);
  const count = parseInt(requestedCodes, 10);
  if (!Number.isInteger(count) || count <= 0 || count > maxCodes) {
    return { success: false, reason: 'invalid_count', maxCodes };
  }

  const claimedBefore = Number(user.referralStockClaimedCodes || 0);
  const merchant = await getReferralStockMerchant();
  const codes = await Code.findAll({
    where: { merchantId: merchant.id, isUsed: false },
    limit: count,
    order: [['id', 'ASC']]
  });

  if (codes.length < count) {
    return { success: false, reason: 'not_enough_stock' };
  }

  const t = await sequelize.transaction();
  try {
    await Code.update(
      { isUsed: true, usedBy: userId, soldAt: new Date() },
      { where: { id: codes.map(c => c.id) }, transaction: t }
    );
    user.referralPoints = Number(user.referralPoints || 0) - (count * requiredPoints);
    user.referralStockClaimedCodes = claimedBefore + count;
    await user.save({ transaction: t });
    await t.commit();

    const codeText = codes.map(c => c.extra ? `${c.value}\n${c.extra}` : c.value).join('\n\n');
    return {
      success: true,
      codes: codeText,
      count,
      claimedBefore,
      claimedAfter: Number(user.referralStockClaimedCodes || 0),
      eligibleNow: Math.floor(Number(user.referralPoints || 0) / requiredPoints),
      points: Number(user.referralPoints || 0),
      adminGranted: Number(user.adminGrantedPoints || 0),
      referralCount,
      milestoneRewards: Number(user.referralMilestoneGrantedPoints || 0)
    };
  } catch (err) {
    await t.rollback();
    console.error('claimReferralStockCodes error:', err);
    return { success: false, reason: 'db_error' };
  }
}

async function takeFallbackChatGptCodesFromReferralStock(userId, quantity) {
  const count = Math.max(0, parseInt(quantity, 10) || 0);
  if (count <= 0) return [];

  const merchant = await getReferralStockMerchant();
  const codes = await Code.findAll({
    where: { merchantId: merchant.id, isUsed: false },
    limit: count,
    order: [['id', 'ASC']]
  });

  if (!codes.length) return [];

  const t = await sequelize.transaction();
  try {
    await Code.update(
      { isUsed: true, usedBy: userId, soldAt: new Date() },
      { where: { id: codes.map(c => c.id) }, transaction: t }
    );
    await t.commit();
    return codes.map(c => c.extra ? `${c.value}\n${c.extra}` : c.value);
  } catch (err) {
    await t.rollback();
    console.error('takeFallbackChatGptCodesFromReferralStock error:', err);
    return [];
  }
}

async function getBulkDiscountThreshold() {
  const rawValue = await getGlobalSetting('bulk_discount_threshold', '50');
  const value = parseInt(rawValue, 10);
  return Number.isInteger(value) && value > 0 ? value : 50;
}

async function getBulkDiscountPrice() {
  const rawValue = await getGlobalSetting('bulk_discount_price', '1');
  const value = parseFloat(rawValue);
  return Number.isFinite(value) && value > 0 ? value : 1;
}

async function getBulkDiscountInfoText(userId) {
  const threshold = await getBulkDiscountThreshold();
  const price = await getBulkDiscountPrice();
  return getText(userId, 'bulkDiscountInfo', { threshold, price });
}

async function getReferralMilestones() {
  const rawValue = await getGlobalSetting('referral_milestones', '15:5,40:5,80:10,150:30');
  const parsed = {};
  for (const part of String(rawValue).split(',')) {
    const [referralsStr, pointsStr] = part.split(':').map(v => String(v || '').trim());
    const referrals = parseInt(referralsStr, 10);
    const points = parseInt(pointsStr, 10);
    if (Number.isInteger(referrals) && referrals > 0 && Number.isInteger(points) && points > 0) {
      parsed[referrals] = points;
    }
  }
  if (!Object.keys(parsed).length) {
    return { 15: 5, 40: 5, 80: 10, 150: 30 };
  }
  return parsed;
}

async function getReferralMilestonesText() {
  const milestones = await getReferralMilestones();
  return Object.entries(milestones)
    .sort((a, b) => Number(a[0]) - Number(b[0]))
    .map(([count, bonus]) => `${count}:${bonus}`)
    .join(', ');
}

async function getReferralMilestoneBonus(referralCount) {
  const milestones = await getReferralMilestones();
  return Number(milestones[String(referralCount)] || 0);
}

async function getCumulativeReferralMilestonePoints(referralCount) {
  const milestones = await getReferralMilestones();
  return Object.entries(milestones)
    .filter(([count]) => Number(referralCount) >= Number(count))
    .reduce((sum, [, bonus]) => sum + Number(bonus || 0), 0);
}

async function getEffectiveRedeemPointsForUser(userId) {
  const basePoints = await getReferralRedeemPoints();
  const user = await User.findByPk(userId);
  const discountPercent = Math.max(0, Math.min(100, parseInt(user?.creatorDiscountPercent || 0, 10) || 0));
  if (discountPercent <= 0) return basePoints;
  return Math.max(1, Math.ceil(basePoints * (100 - discountPercent) / 100));
}

async function canUserClaimFreeCode(userId) {
  const user = await User.findByPk(userId);
  if (!user) return false;
  if (!user.lastFreeCodeClaimAt) return true;
  const cooldownDays = await getFreeCodeCooldownDays();
  const nextAllowedAt = new Date(new Date(user.lastFreeCodeClaimAt).getTime() + (cooldownDays * 24 * 60 * 60 * 1000));
  return Date.now() >= nextAllowedAt.getTime();
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function formatCodesForHtml(codeTextOrArray) {
  const codes = Array.isArray(codeTextOrArray)
    ? codeTextOrArray
    : String(codeTextOrArray || '').split(/\n\n+/).filter(Boolean);
  return codes.map(code => `<code>${escapeHtml(code)}</code>`).join('\n\n');
}

async function getPerCodePriceForQuantity(basePrice, quantity) {
  const safeBasePrice = parseFloat(basePrice) || 0;
  const safeQty = parseInt(quantity, 10) || 0;
  const threshold = await getBulkDiscountThreshold();
  const discountPrice = await getBulkDiscountPrice();
  if (safeQty >= threshold && safeBasePrice > discountPrice) return discountPrice;
  return safeBasePrice;
}


function formatDateParts(date) {
  const d = new Date(date);
  return {
    year: d.getFullYear(),
    month: String(d.getMonth() + 1).padStart(2, '0'),
    day: String(d.getDate()).padStart(2, '0'),
    hour: String(d.getHours()).padStart(2, '0'),
    minute: String(d.getMinutes()).padStart(2, '0'),
    second: String(d.getSeconds()).padStart(2, '0')
  };
}

async function getUserReferralLink(userId) {
  const botInfo = await bot.getMe();
  const publicUsername = process.env.PUBLIC_BOT_USERNAME || botInfo.username;
  return `https://t.me/${publicUsername}?start=${userId}`;
}

async function findOrCreateUser(userId) {
  const [user] = await User.findOrCreate({
    where: { id: userId },
    defaults: {
      lang: 'en',
      balance: 0,
      referralCode: generateReferralCode(userId)
    }
  });

  if (!user.referralCode) {
    user.referralCode = generateReferralCode(userId);
    await user.save();
  }

  return user;
}

async function getTelegramIdentityById(targetUserId) {
  try {
    const chat = await bot.getChat(targetUserId);
    return {
      usernameText: chat?.username ? `@${chat.username}` : 'لا يوجد',
      fullName: [chat?.first_name, chat?.last_name].filter(Boolean).join(' ').trim() || chat?.title || String(targetUserId)
    };
  } catch {
    return {
      usernameText: 'لا يوجد',
      fullName: String(targetUserId)
    };
  }
}

async function getChannelConfig() {
  let config = await ChannelConfig.findOne();
  if (!config) {
    config = await ChannelConfig.create({
      enabled: false,
      link: null,
      messageText: null,
      chatId: null,
      username: null,
      title: null
    });
  }

  if (config.link && !config.chatId) {
    await ensureChannelConfigResolved(config);
  }

  return config;
}

async function isMandatoryVerificationEnabled() {
  const config = await getChannelConfig();
  return Boolean(config.enabled);
}

async function isVerificationRequiredForUser(userId) {
  if (isAdmin(userId)) return false;

  const config = await getChannelConfig();
  if (!config.enabled) return false;

  const hasTarget = Boolean(config.chatId || config.username || parseChannelTarget(config.link));
  return hasTarget;
}

function parseChannelTarget(value) {
  if (!value) return null;
  let target = String(value).trim();

  target = target
    .replace(/^https?:\/\/t\.me\//i, '')
    .replace(/^t\.me\//i, '')
    .replace(/^telegram\.me\//i, '');

  target = target.split(/[/?#]/)[0].trim();

  if (!target) return null;
  if (/^(\+|joinchat)/i.test(target)) return null;
  if (/^-100\d+$/.test(target)) return target;
  if (target.startsWith('@')) return target;
  if (/^[A-Za-z0-9_]{5,}$/.test(target)) return `@${target}`;
  return null;
}

async function resolveChannelTarget(input) {
  const raw = String(input || '').trim();
  if (!raw) {
    return { ok: false, reason: 'empty', message: 'Channel value is empty.' };
  }

  if (/t\.me\/(\+|joinchat)/i.test(raw)) {
    return {
      ok: false,
      reason: 'invite_link_not_supported',
      message: 'Invite links like t.me/+... cannot be checked reliably. Send @channelusername or the numeric chat id that starts with -100.'
    };
  }

  const target = parseChannelTarget(raw);
  if (!target) {
    return {
      ok: false,
      reason: 'invalid_target',
      message: 'Invalid channel value. Send @channelusername or the numeric chat id that starts with -100.'
    };
  }

  try {
    const chat = await bot.getChat(target);
    const username = chat.username ? `@${chat.username}` : (target.startsWith('@') ? target : null);
    const link = chat.username ? `https://t.me/${chat.username}` : raw;

    return {
      ok: true,
      chatId: String(chat.id),
      username,
      title: chat.title || username || String(chat.id),
      link,
      type: chat.type
    };
  } catch (err) {
    console.error('Error resolving channel target:', err.response?.body || err.message);
    return {
      ok: false,
      reason: 'resolve_failed',
      message: 'The bot could not access this channel. Make sure the bot is added as an administrator in the channel, then send @channelusername or the chat id again.'
    };
  }
}

async function ensureChannelConfigResolved(config) {
  if (!config || !config.link || config.chatId) return config;

  const resolved = await resolveChannelTarget(config.link);
  if (!resolved.ok) return config;

  config.chatId = resolved.chatId;
  config.username = resolved.username;
  config.title = resolved.title;
  config.link = resolved.link || config.link;
  await config.save();
  return config;
}

async function checkChannelMembership(userId) {
  if (isAdmin(userId)) return true;

  const config = await getChannelConfig();
  if (!config.enabled) return true;
  if (!config.link && !config.chatId && !config.username) return true;

  const targets = [];
  if (config.chatId) targets.push(String(config.chatId));
  if (config.username) targets.push(String(config.username));

  const parsedFromLink = parseChannelTarget(config.link);
  if (parsedFromLink && !targets.includes(parsedFromLink)) {
    targets.push(parsedFromLink);
  }

  if (targets.length === 0) {
    console.error('❌ Mandatory verification is enabled, but no verifiable channel target was found.');
    return false;
  }

  for (const target of targets) {
    try {
      const chatMember = await bot.getChatMember(target, userId);

      if (['member', 'administrator', 'creator'].includes(chatMember.status)) {
        return true;
      }

      if (['left', 'kicked'].includes(chatMember.status)) {
        return false;
      }

      if (chatMember.status === 'restricted') {
        return true;
      }
    } catch (err) {
      const body = err.response?.body || {};
      console.error(`Error checking channel membership with target ${target}:`, body || err.message);
    }
  }

  return false;
}

async function sendJoinChannelMessage(userId) {
  const config = await getChannelConfig();
  if (isAdmin(userId) || !config.enabled) return;

  const extraParts = [];
  if (config.messageText) extraParts.push(config.messageText);
  if (config.title) extraParts.push(`Channel: ${config.title}`);
  if (config.username && (!config.link || !config.link.includes('t.me/'))) {
    extraParts.push(config.username);
  }

  const extraMessage = extraParts.join('\n');
  const finalMsg = await getText(userId, 'mustJoinChannel', { message: extraMessage });

  const joinUrl =
    config.link ||
    (config.username ? `https://t.me/${config.username.replace(/^@/, '')}` : null);

  const keyboardRows = [];
  if (joinUrl) {
    keyboardRows.push([{ text: await getText(userId, 'joinChannel'), url: joinUrl }]);
  }
  keyboardRows.push([{ text: await getText(userId, 'checkSubscription'), callback_data: 'check_subscription' }]);

  await bot.sendMessage(userId, finalMsg, {
    reply_markup: { inline_keyboard: keyboardRows }
  });
}

function generateCaptcha() {
  const a = Math.floor(Math.random() * 10);
  const b = Math.floor(Math.random() * 10);
  return { challenge: `${a} + ${b}`, answer: a + b };
}

async function createCaptcha(userId) {
  const { challenge, answer } = generateCaptcha();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
  await Captcha.upsert({ userId, challenge, answer, expiresAt });
  return challenge;
}

async function verifyCaptcha(userId, answerText) {
  const captcha = await Captcha.findByPk(userId);
  if (!captcha) return false;
  if (captcha.expiresAt < new Date()) {
    await Captcha.destroy({ where: { userId } });
    return false;
  }

  const value = parseInt(String(answerText).trim(), 10);
  if (Number.isNaN(value)) return false;

  if (value === captcha.answer) {
    await Captcha.destroy({ where: { userId } });
    return true;
  }

  return false;
}

async function awardReferralPoints(referredUserId) {
  const t = await sequelize.transaction();
  try {
    const referred = await User.findByPk(referredUserId, {
      transaction: t,
      lock: t.LOCK.UPDATE
    });

    if (!referred || !referred.referredBy || referred.referralRewarded) {
      await t.rollback();
      return false;
    }

    const referrer = await User.findByPk(referred.referredBy, {
      transaction: t,
      lock: t.LOCK.UPDATE
    });

    if (!referrer) {
      await t.rollback();
      return false;
    }

    const [updatedCount] = await User.update(
      { referralRewarded: true },
      {
        where: {
          id: referredUserId,
          referredBy: referred.referredBy,
          referralRewarded: false
        },
        transaction: t
      }
    );

    if (updatedCount !== 1) {
      await t.rollback();
      return false;
    }

    await User.increment(
      { referralPoints: 1 },
      {
        where: { id: referrer.id },
        transaction: t
      }
    );

    const rewardedReferralCount = await User.count({
      where: {
        referredBy: referrer.id,
        referralRewarded: true
      },
      transaction: t
    });

    const milestoneBonus = await getReferralMilestoneBonus(rewardedReferralCount);
    if (milestoneBonus > 0) {
      await User.increment(
        { referralPoints: milestoneBonus, referralMilestoneGrantedPoints: milestoneBonus },
        {
          where: { id: referrer.id },
          transaction: t
        }
      );
    }

    await t.commit();

    const updatedReferrer = await User.findByPk(referrer.id);
    const updatedPoints = Number(updatedReferrer?.referralPoints || 0);

    await bot.sendMessage(referrer.id, await getText(referrer.id, 'referralEarned', {
      points: updatedPoints
    }));

    if (milestoneBonus > 0) {
      await bot.sendMessage(referrer.id, await getText(referrer.id, 'referralMilestoneBonus', {
        bonus: milestoneBonus,
        points: updatedPoints
      }));
    }

    return true;
  } catch (err) {
    await t.rollback().catch(() => {});
    console.error('awardReferralPoints error:', err);
    return false;
  }
}

async function tryAwardReferralIfEligible(userId) {
  if (!(await getReferralEnabled())) return false;
  const user = await User.findByPk(userId);
  if (!user || !user.referredBy || user.referralRewarded) return false;

  const verificationRequired = await isVerificationRequiredForUser(userId);
  if (verificationRequired && !user.verified) return false;

  return awardReferralPoints(userId);
}

async function ensureUserAccess(userId, options = {}) {
  const { sendJoinPrompt = true, sendCaptchaPrompt = true } = options;
  const user = await User.findByPk(userId);
  if (!user) return false;
  if (isAdmin(userId)) return true;

  const verificationRequired = await isVerificationRequiredForUser(userId);
  if (!verificationRequired) return true;

  const isMember = await checkChannelMembership(userId);
  if (!isMember) {
    if (sendJoinPrompt) await sendJoinChannelMessage(userId);
    return false;
  }

  if (user.verified) return true;

  let captcha = await Captcha.findByPk(userId);
  if (!captcha || captcha.expiresAt < new Date()) {
    const challenge = await createCaptcha(userId);
    if (sendCaptchaPrompt) {
      await bot.sendMessage(userId, await getText(userId, 'captchaChallenge', { challenge }));
    }
    return false;
  }

  if (sendCaptchaPrompt) {
    await bot.sendMessage(userId, await getText(userId, 'captchaChallenge', { challenge: captcha.challenge }));
  }

  return false;
}

async function handleVerificationSuccess(userId) {
  const user = await User.findByPk(userId);
  if (!user) return;

  if (!user.verified) {
    user.verified = true;
    await user.save();
  }

  await bot.sendMessage(userId, await getText(userId, 'captchaSuccess'));

  await tryAwardReferralIfEligible(userId);

  await sendMainMenu(userId);
}

const DEFAULT_BUTTONS = {
  redeem: true,
  buy: true,
  my_balance: true,
  deposit: true,
  referral: true,
  discount: true,
  my_purchases: true,
  support: true,
  chatgpt_code: true,
  free_code: true,
  admin_panel: true
};

const DEFAULT_BUTTON_ORDER = [
  'redeem',
  'buy',
  'my_balance',
  'deposit',
  'referral',
  'discount',
  'my_purchases',
  'support',
  'chatgpt_code',
  'free_code',
  'admin_panel'
];

async function getMenuButtonsVisibility() {
  const setting = await Setting.findOne({ where: { key: 'menu_buttons', lang: 'global' } });
  if (!setting) return { ...DEFAULT_BUTTONS };

  try {
    return { ...DEFAULT_BUTTONS, ...JSON.parse(setting.value) };
  } catch {
    return { ...DEFAULT_BUTTONS };
  }
}

async function setMenuButtonsVisibility(visibility) {
  await Setting.upsert({
    key: 'menu_buttons',
    lang: 'global',
    value: JSON.stringify(visibility)
  });
}

async function getMenuButtonsOrder() {
  const setting = await Setting.findOne({ where: { key: 'menu_buttons_order', lang: 'global' } });
  if (!setting) return [...DEFAULT_BUTTON_ORDER];

  try {
    const savedOrder = JSON.parse(setting.value);
    if (!Array.isArray(savedOrder)) return [...DEFAULT_BUTTON_ORDER];

    const validSaved = savedOrder.filter(id => DEFAULT_BUTTON_ORDER.includes(id));
    const missing = DEFAULT_BUTTON_ORDER.filter(id => !validSaved.includes(id));
    return [...validSaved, ...missing];
  } catch {
    return [...DEFAULT_BUTTON_ORDER];
  }
}

async function setMenuButtonsOrder(order) {
  await Setting.upsert({
    key: 'menu_buttons_order',
    lang: 'global',
    value: JSON.stringify(order)
  });
}

async function moveMenuButton(buttonId, direction) {
  const order = await getMenuButtonsOrder();
  const index = order.indexOf(buttonId);
  if (index === -1) return false;

  const targetIndex = direction === 'up' ? index - 1 : index + 1;
  if (targetIndex < 0 || targetIndex >= order.length) return false;

  [order[index], order[targetIndex]] = [order[targetIndex], order[index]];
  await setMenuButtonsOrder(order);
  return true;
}

async function getMenuButtonItems(userId) {
  return [
    { id: 'redeem', name: await getText(userId, 'redeem') },
    { id: 'buy', name: await getText(userId, 'buy') },
    { id: 'my_balance', name: await getText(userId, 'myBalance') },
    { id: 'deposit', name: await getText(userId, 'deposit') },
    { id: 'referral', name: await getText(userId, 'referral') },
    { id: 'referral_prize', name: await getText(userId, 'referralStockClaim') },
    { id: 'discount', name: '🎟️ Discount' },
    { id: 'my_purchases', name: await getText(userId, 'myPurchases') },
    { id: 'support', name: await getText(userId, 'support') },
    { id: 'chatgpt_code', name: ((await getProductSectionByKey('gpt'))?.nameAr || (await getProductSectionByKey('gpt'))?.nameEn || await getText(userId, 'chatgptCode')) },
    { id: 'free_code', name: await getText(userId, 'freeCodeMenu') },
    { id: 'admin_panel', name: await getText(userId, 'adminPanel') }
  ];
}

async function showMenuButtonsAdmin(userId) {
  const visibility = await getMenuButtonsVisibility();
  const items = await getMenuButtonItems(userId);
  const itemsMap = new Map(items.map(item => [item.id, item]));
  const order = await getMenuButtonsOrder();
  const orderedItems = order.map(id => itemsMap.get(id)).filter(Boolean);

  const keyboard = [];
  for (let i = 0; i < orderedItems.length; i += 1) {
    const item = orderedItems[i];
    const enabled = visibility[item.id] !== false;
    const action = enabled ? 'hide' : 'show';

    keyboard.push([
      {
        text: `${enabled ? '✅' : '❌'} ${item.name}`,
        callback_data: `toggle_button_${item.id}_${action}`
      },
      {
        text: '⬆️',
        callback_data: i === 0 ? 'ignore' : `move_button_${item.id}_up`
      },
      {
        text: '⬇️',
        callback_data: i === orderedItems.length - 1 ? 'ignore' : `move_button_${item.id}_down`
      }
    ]);
  }

  keyboard.push([{ text: await getText(userId, 'back'), callback_data: 'admin' }]);

  await bot.sendMessage(userId, await getText(userId, 'manageMenuButtons'), {
    reply_markup: { inline_keyboard: keyboard }
  });
}

async function toggleMenuButton(buttonId, action) {
  const visibility = await getMenuButtonsVisibility();
  visibility[buttonId] = action === 'show';
  await setMenuButtonsVisibility(visibility);
}


function getDefaultDepositValues(currency) {
  if (currency === 'USD') {
    return {
      currency: 'USD',
      rate: 1,
      walletAddress: 'T...',
      instructions: 'Send USDT to one of the payment methods above.',
      displayNameEn: 'Binance',
      displayNameAr: 'بايننس',
      templateEn: '💰 Send {amount} USDT to one of the following payment methods:\n\n{methods_block}\n\nThen send a screenshot of the payment with any message.\n\n{instructions}',
      templateAr: '💰 قم بإرسال {amount} USDT إلى إحدى طرق الدفع التالية:\n\n{methods_block}\n\nثم أرسل صورة التحويل مع أي رسالة.\n\n{instructions}',
      methods: [{ nameAr: 'بايننس', nameEn: 'Binance', value: '123456' }]
    };
  }
  return {
    currency: 'IQD',
    rate: 1500,
    walletAddress: 'SuperKey...',
    instructions: 'Send IQD to one of the payment methods above.',
    displayNameEn: 'Iraqi Dinar',
    displayNameAr: 'دينار عراقي',
    templateEn: '💰 Send {amountIQD} Iraqi Dinar (≈ {amountUSD} USD at rate {rate} IQD/USD) to one of the following payment methods:\n\n{methods_block}\n\nThen send a screenshot of the payment with any message.\n\n{instructions}',
    templateAr: '💰 قم بإرسال {amountIQD} دينار عراقي (≈ {amountUSD} دولار بسعر صرف {rate} دينار/دولار) إلى إحدى طرق الدفع التالية:\n\n{methods_block}\n\nثم أرسل صورة التحويل مع أي رسالة.\n\n{instructions}',
    methods: [{ nameAr: 'سوبركي', nameEn: 'SuperKey', value: '123456' }]
  };
}

function normalizeDepositMethods(methods) {
  if (Array.isArray(methods)) return methods.filter(Boolean);
  if (!methods) return [];
  try {
    const parsed = typeof methods === 'string' ? JSON.parse(methods) : methods;
    return Array.isArray(parsed) ? parsed.filter(Boolean) : [];
  } catch {
    return [];
  }
}

async function getDepositConfig(currency) {
  let config = await DepositConfig.findOne({ where: { currency } });
  const defaults = getDefaultDepositValues(currency);

  if (!config) {
    config = await DepositConfig.create({ ...defaults, isActive: true });
  } else {
    let changed = false;

    for (const [key, value] of Object.entries(defaults)) {
      const current = config[key];
      if (
        current === null ||
        current === undefined ||
        current === '' ||
        (key === 'methods' && (!Array.isArray(current) || current.length === 0))
      ) {
        config[key] = value;
        changed = true;
      }
    }

    const methods = normalizeDepositMethods(config.methods);
    if (methods.length === 0 && config.walletAddress) {
      config.methods = [{
        nameAr: currency === 'USD' ? 'بايننس' : 'سوبركي',
        nameEn: currency === 'USD' ? 'Binance' : 'SuperKey',
        value: config.walletAddress
      }];
      changed = true;
    } else {
      config.methods = methods;
    }

    if (changed) await config.save();
  }

  return config;
}

async function updateDepositConfig(currency, field, value) {
  const config = await getDepositConfig(currency);
  config[field] = value;
  await config.save();
  return config;
}

async function getDepositDisplayName(userId, currency) {
  const user = await User.findByPk(userId);
  const lang = user?.lang || 'en';
  const config = await getDepositConfig(currency);
  return lang === 'ar' ? (config.displayNameAr || getDefaultDepositValues(currency).displayNameAr) : (config.displayNameEn || getDefaultDepositValues(currency).displayNameEn);
}

function formatDepositMethodsForMessage(methods, lang) {
  const list = normalizeDepositMethods(methods);
  if (list.length === 0) return '`N/A`';
  return list.map((item) => {
    const name = lang === 'ar' ? (item.nameAr || item.nameEn || 'طريقة دفع') : (item.nameEn || item.nameAr || 'Payment Method');
    return `• ${name}: \`${item.value}\``;
  }).join('\n');
}

async function renderDepositMessage(userId, currency, amount) {
  const user = await User.findByPk(userId);
  const lang = user?.lang || 'en';
  const config = await getDepositConfig(currency);
  const template = lang === 'ar' ? (config.templateAr || getDefaultDepositValues(currency).templateAr) : (config.templateEn || getDefaultDepositValues(currency).templateEn);
  const amountIQDRaw = currency === 'IQD' ? amount * config.rate : null;
  const amountIQD = amountIQDRaw === null ? null : Number(amountIQDRaw).toLocaleString('en-US', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0
  });
  const methodsBlock = formatDepositMethodsForMessage(config.methods, lang);

  let msg = template;
  const replacements = {
    amount: amount,
    amountUSD: amount,
    amountIQD: amountIQD,
    rate: config.rate,
    methods_block: methodsBlock,
    instructions: config.instructions || '',
    address: config.walletAddress || ''
  };

  for (const [k, v] of Object.entries(replacements)) {
    msg = msg.replace(new RegExp(`\\{${k}\\}`, 'g'), v === null || v === undefined ? '' : String(v));
  }

  return msg;
}

async function showDepositSettingsAdmin(userId) {
  const usdConfig = await getDepositConfig('USD');
  const iqdConfig = await getDepositConfig('IQD');

  const formatMethods = (methods, lang) => {
    const list = normalizeDepositMethods(methods);
    if (list.length === 0) return lang === 'ar' ? 'لا توجد طرق دفع' : 'No methods';
    return list.map((m, i) => {
      const name = lang === 'ar' ? (m.nameAr || m.nameEn) : (m.nameEn || m.nameAr);
      return `${i + 1}. ${name}: ${m.value}`;
    }).join('\n');
  };

  const msg =
    `💱 *${await getText(userId, 'manageDepositSettings')}*\n\n` +
    `• ${iqdConfig.displayNameAr} / ${iqdConfig.displayNameEn}\n` +
    `Rate: ${iqdConfig.rate} IQD/USD\n` +
    `${formatMethods(iqdConfig.methods, 'ar')}\n\n` +
    `• ${usdConfig.displayNameAr} / ${usdConfig.displayNameEn}\n` +
    `${formatMethods(usdConfig.methods, 'ar')}`;

  const keyboard = {
    inline_keyboard: [
      [{ text: await getText(userId, 'setIQDRate'), callback_data: 'admin_set_iqd_rate' }],
      [{ text: await getText(userId, 'editCurrencyNames'), callback_data: 'admin_edit_currency_names' }],
      [{ text: await getText(userId, 'editDepositTemplates'), callback_data: 'admin_edit_deposit_instructions' }],
      [{ text: await getText(userId, 'manageIQDMethods'), callback_data: 'admin_manage_iqd_methods' }],
      [{ text: await getText(userId, 'manageUSDMethods'), callback_data: 'admin_manage_usd_methods' }],
      [{ text: await getText(userId, 'back'), callback_data: 'admin' }]
    ]
  };

  await bot.sendMessage(userId, msg, { parse_mode: 'Markdown', reply_markup: keyboard });
}

async function showCurrencyNamesEdit(userId) {
  const usd = await getDepositConfig('USD');
  const iqd = await getDepositConfig('IQD');
  const msg =
    `✏️ *${await getText(userId, 'editCurrencyNames')}*\n\n` +
    `IQD: ${iqd.displayNameAr} / ${iqd.displayNameEn}\n` +
    `USD: ${usd.displayNameAr} / ${usd.displayNameEn}`;

  const keyboard = {
    inline_keyboard: [
      [{ text: await getText(userId, 'editIQDNameAr'), callback_data: 'admin_edit_name_IQD_ar' }],
      [{ text: await getText(userId, 'editIQDNameEn'), callback_data: 'admin_edit_name_IQD_en' }],
      [{ text: await getText(userId, 'editUSDNameAr'), callback_data: 'admin_edit_name_USD_ar' }],
      [{ text: await getText(userId, 'editUSDNameEn'), callback_data: 'admin_edit_name_USD_en' }],
      [{ text: await getText(userId, 'back'), callback_data: 'admin_manage_deposit_settings' }]
    ]
  };

  await bot.sendMessage(userId, msg, { parse_mode: 'Markdown', reply_markup: keyboard });
}

async function showDepositInstructionsEdit(userId) {
  const keyboard = {
    inline_keyboard: [
      [{ text: await getText(userId, 'editIQDTemplateAr'), callback_data: 'admin_edit_template_IQD_ar' }],
      [{ text: await getText(userId, 'editIQDTemplateEn'), callback_data: 'admin_edit_template_IQD_en' }],
      [{ text: await getText(userId, 'editUSDTemplateAr'), callback_data: 'admin_edit_template_USD_ar' }],
      [{ text: await getText(userId, 'editUSDTemplateEn'), callback_data: 'admin_edit_template_USD_en' }],
      [{ text: await getText(userId, 'back'), callback_data: 'admin_manage_deposit_settings' }]
    ]
  };

  await bot.sendMessage(userId, await getText(userId, 'editDepositTemplates'), { reply_markup: keyboard });
}

async function showDepositMethodsAdmin(userId, currency) {
  const config = await getDepositConfig(currency);
  const methods = normalizeDepositMethods(config.methods);
  const title = currency === 'IQD' ? await getText(userId, 'manageIQDMethods') : await getText(userId, 'manageUSDMethods');

  let msg = `💳 *${title}*\n\n`;
  if (methods.length === 0) {
    msg += await getText(userId, 'noMethods');
  } else {
    msg += methods.map((m, i) => `${i + 1}. ${m.nameAr || m.nameEn} / ${m.nameEn || m.nameAr}\n\`${m.value}\``).join('\n\n');
  }

  const keyboard = {
    inline_keyboard: [
      [{ text: await getText(userId, 'addDepositMethod'), callback_data: `admin_add_deposit_method_${currency}` }],
      [{ text: await getText(userId, 'deleteDepositMethod'), callback_data: `admin_delete_deposit_method_menu_${currency}` }],
      [{ text: await getText(userId, 'back'), callback_data: 'admin_manage_deposit_settings' }]
    ]
  };

  await bot.sendMessage(userId, msg, { parse_mode: 'Markdown', reply_markup: keyboard });
}

async function showDeleteDepositMethodsMenu(userId, currency) {
  const config = await getDepositConfig(currency);
  const methods = normalizeDepositMethods(config.methods);
  const buttons = methods.map((m, i) => [{ text: `${m.nameAr || m.nameEn} / ${m.nameEn || m.nameAr}`, callback_data: `admin_delete_deposit_method_${currency}_${i}` }]);
  buttons.push([{ text: await getText(userId, 'back'), callback_data: currency === 'IQD' ? 'admin_manage_iqd_methods' : 'admin_manage_usd_methods' }]);
  await bot.sendMessage(userId, await getText(userId, 'deleteDepositMethod'), { reply_markup: { inline_keyboard: buttons } });
}

async function addDepositMethod(currency, methodData) {
  const config = await getDepositConfig(currency);
  const methods = normalizeDepositMethods(config.methods);
  methods.push(methodData);
  config.methods = methods;
  if (!config.walletAddress) config.walletAddress = methodData.value;
  await config.save();
  return config;
}

async function deleteDepositMethod(currency, index) {
  const config = await getDepositConfig(currency);
  const methods = normalizeDepositMethods(config.methods);
  if (index >= 0 && index < methods.length) {
    methods.splice(index, 1);
    config.methods = methods;
    await config.save();
  }
  return config;
}

async function showCurrencyOptions(userId) {
  const keyboard = {
    inline_keyboard: [
      [{ text: await getDepositDisplayName(userId, 'IQD'), callback_data: 'deposit_currency_iqd' }],
      [{ text: await getDepositDisplayName(userId, 'USD'), callback_data: 'deposit_currency_usd' }],
      [{ text: await getText(userId, 'back'), callback_data: 'back_to_menu' }]
    ]
  };

  await bot.sendMessage(userId, await getText(userId, 'chooseCurrency'), { reply_markup: keyboard });
}

async function showPaymentMethodsForDeposit(userId, amount, currency) {
  const msg = await renderDepositMessage(userId, currency, amount);
  await bot.sendMessage(userId, msg, { parse_mode: 'Markdown' });
  await setUserState(userId, { action: 'deposit_awaiting_proof', amount, currency });
}


async function sendMainMenu(userId) {
  const canUse = await ensureUserAccess(userId, { sendJoinPrompt: true, sendCaptchaPrompt: true });
  if (!canUse) return;

  const visibility = await getMenuButtonsVisibility();
  const redeemableReferralCodes = await getRedeemableReferralCodesCount(userId);
  const gptSection = await getProductSectionByKey('gpt');
  const allSections = await getProductSections();
  const normalButtons = [
    { id: 'my_balance', text: await getText(userId, 'myBalance') },
    { id: 'deposit', text: await getText(userId, 'deposit') },
    { id: 'referral', text: await getText(userId, 'referral') },
    { id: 'discount', text: '🎟️ Discount' },
    { id: 'my_purchases', text: await getText(userId, 'myPurchases') },
    { id: 'support', text: await getText(userId, 'support') },
    { id: 'free_code', text: await getText(userId, 'freeCodeMenu') }
  ];

  const buttons = [];

  if (visibility.chatgpt_code !== false) {
    buttons.push([{ text: await getLocalizedSectionName(userId, gptSection || { nameEn: 'GPT', nameAr: 'GPT' }), callback_data: 'chatgpt_code' }]);
    for (const merchantId of await getFeaturedProductIdsForSection('gpt')) {
      const merchant = await Merchant.findByPk(merchantId);
      if (!merchant) continue;
      buttons.push([{ text: `⭐ ${await getLocalizedMerchantName(userId, merchant)} ($${Number(merchant.price || 0).toFixed(2)})`, callback_data: `buy_merchant_${merchant.id}` }]);
    }
  }

  for (const section of allSections.filter(s => s.key !== 'gpt')) {
    buttons.push([{ text: await getLocalizedSectionName(userId, section), callback_data: `front_section_${section.key}` }]);
    for (const merchantId of await getFeaturedProductIdsForSection(section.key)) {
      const merchant = await Merchant.findByPk(merchantId);
      if (!merchant) continue;
      buttons.push([{ text: `⭐ ${await getLocalizedMerchantName(userId, merchant)} ($${Number(merchant.price || 0).toFixed(2)})`, callback_data: `buy_merchant_${merchant.id}` }]);
    }
  }

  for (const item of normalButtons) {
    if (item.id === 'free_code' && visibility[item.id] === false) continue;
    if (item.id === 'discount' && visibility[item.id] === false) continue;
    if (item.id === 'my_balance' && visibility[item.id] === false) continue;
    if (item.id === 'deposit' && visibility[item.id] === false) continue;
    if (item.id === 'referral' && visibility[item.id] === false) continue;
    if (item.id === 'my_purchases' && visibility[item.id] === false) continue;
    if (item.id === 'support' && visibility[item.id] === false) continue;
    buttons.push([{ text: item.text, callback_data: item.id }]);
  }

  if (visibility.referral_prize !== false && redeemableReferralCodes > 0) {
    buttons.push([{ text: await getText(userId, 'referralStockClaim'), callback_data: 'referral_prize' }]);
  }

  if (isAdmin(userId) && visibility.admin_panel !== false) {
    buttons.push([{ text: await getText(userId, 'adminPanel'), callback_data: 'admin' }]);
  }

  await bot.sendMessage(userId, await getText(userId, 'menu'), {
    reply_markup: { inline_keyboard: buttons }
  });
}

async function showAdminPanel(userId) {
  if (!isAdmin(userId)) return;

  const keyboard = {
    inline_keyboard: [
      [{ text: await getText(userId, 'manageBots'), callback_data: 'admin_manage_bots' }],
      [{ text: await getText(userId, 'manageMenuButtons'), callback_data: 'admin_manage_menu_buttons' }],
      [{ text: await getText(userId, 'manageChannel'), callback_data: 'admin_manage_channel' }],
      [{ text: await getText(userId, 'manageDepositSettings'), callback_data: 'admin_manage_deposit_settings' }],
      [{ text: await getText(userId, 'productsSection'), callback_data: 'admin_section_products' }],
      [{ text: await getText(userId, 'addMerchant'), callback_data: 'admin_add_merchant' }],
      [{ text: await getText(userId, 'listMerchants'), callback_data: 'admin_list_merchants' }],
      [{ text: await getText(userId, 'setPrice'), callback_data: 'admin_set_price' }],
      [{ text: await getText(userId, 'setChatgptPrice'), callback_data: 'admin_set_chatgpt_price' }],
      [{ text: await getText(userId, 'addCodes'), callback_data: 'admin_add_codes' }],
      [{ text: await getText(userId, 'paymentMethods'), callback_data: 'admin_payment_methods' }],
      [{ text: await getText(userId, 'stats'), callback_data: 'admin_stats' }],
      [{ text: await getText(userId, 'referralSettings'), callback_data: 'admin_referral_settings' }],
      [{ text: await getText(userId, 'manageRedeemServices'), callback_data: 'admin_manage_redeem_services' }],
      [{ text: await getText(userId, 'manageDiscountCodes'), callback_data: 'admin_manage_discount_codes' }],
      [{ text: await getText(userId, 'quantityDiscountSettings'), callback_data: 'admin_quantity_discount_settings' }],
      [{ text: await getText(userId, 'botControl'), callback_data: 'admin_bot_control' }],
      [{ text: await getText(userId, 'balanceManagement'), callback_data: 'admin_balance_management' }],
      [{ text: await getText(userId, 'sendAnnouncement'), callback_data: 'admin_send_announcement' }],
      [{ text: await getText(userId, 'editCodeDeliveryMessage'), callback_data: 'admin_edit_code_delivery_message' }],
      [{ text: await getText(userId, 'back'), callback_data: 'back_to_menu' }]
    ]
  };

  await bot.sendMessage(userId, await getText(userId, 'adminPanel'), { reply_markup: keyboard });
}

async function showReferralSettingsAdmin(userId) {
  const percent = await getReferralPercent();
  const redeemPoints = await getReferralRedeemPoints();
  const freeCodeDays = await getFreeCodeCooldownDays();
  const milestonesText = await getReferralMilestonesText();
  const referralsEnabled = await getReferralEnabled();
  const percentLine = await getText(userId, 'currentReferralPercent', { percent });
  const pointsLine = await getText(userId, 'currentRedeemPoints', { points: redeemPoints });
  const freeCodeDaysLine = await getText(userId, 'currentFreeCodeDays', { days: freeCodeDays });
  const milestonesLine = await getText(userId, 'currentReferralMilestones', { milestones: milestonesText });
  const referralsStatusLine = await getText(userId, referralsEnabled ? 'referralsEnabledStatus' : 'referralsDisabledStatus');

  const keyboard = {
    inline_keyboard: [
      [{ text: await getText(userId, 'setReferralPercent'), callback_data: 'admin_set_referral_percent' }],
      [{ text: await getText(userId, 'setRedeemPoints'), callback_data: 'admin_set_redeem_points' }],
      [{ text: await getText(userId, 'setFreeCodeDays'), callback_data: 'admin_set_free_code_days' }],
      [{ text: await getText(userId, 'editReferralMilestones'), callback_data: 'admin_edit_referral_milestones' }],
      [{ text: await getText(userId, 'referralEligibleUsers'), callback_data: 'admin_referral_eligible_users' }],
      [{ text: await getText(userId, 'grantPoints'), callback_data: 'admin_grant_points' }],
      [{ text: await getText(userId, 'deductReferralPoints'), callback_data: 'admin_deduct_points' }],
      [{ text: await getText(userId, 'grantCreatorDiscount'), callback_data: 'admin_grant_creator_discount' }],
      [{ text: await getText(userId, 'referralStockSettings'), callback_data: 'admin_referral_stock_settings' }],
      [{ text: await getText(userId, 'toggleReferrals'), callback_data: 'admin_toggle_referrals' }],
      [{ text: await getText(userId, 'back'), callback_data: 'admin' }]
    ]
  };

  await bot.sendMessage(
    userId,
    await getText(userId, 'manageReferralSettingsText', { percentLine, pointsLine, freeCodeDaysLine, milestonesLine, referralsStatusLine }),
    { reply_markup: keyboard }
  );
}


async function showQuantityDiscountSettingsAdmin(userId) {
  const threshold = await getBulkDiscountThreshold();
  const price = await getBulkDiscountPrice();
  const thresholdLine = await getText(userId, 'currentBulkDiscountThreshold', { threshold });
  const priceLine = await getText(userId, 'currentBulkDiscountPrice', { price });
  const keyboard = {
    inline_keyboard: [
      [{ text: await getText(userId, 'setBulkDiscountThreshold'), callback_data: 'admin_set_bulk_discount_threshold' }],
      [{ text: await getText(userId, 'setBulkDiscountPrice'), callback_data: 'admin_set_bulk_discount_price' }],
      [{ text: await getText(userId, 'back'), callback_data: 'admin' }]
    ]
  };
  await bot.sendMessage(
    userId,
    await getText(userId, 'quantityDiscountSettingsText', { thresholdLine, priceLine }),
    { reply_markup: keyboard }
  );
}

async function showReferralStockSettingsAdmin(userId) {
  const merchant = await getReferralStockMerchant();
  const count = await Code.count({ where: { merchantId: merchant.id, isUsed: false } });
  const keyboard = {
    inline_keyboard: [
      [{ text: await getText(userId, 'addReferralStockCodes'), callback_data: 'admin_add_referral_stock_codes' }],
      [{ text: await getText(userId, 'viewReferralStockCount'), callback_data: 'admin_view_referral_stock_count' }],
      [{ text: await getText(userId, 'back'), callback_data: 'admin_referral_settings' }]
    ]
  };
  await bot.sendMessage(userId, await getText(userId, 'referralStockCountText', { count }), { reply_markup: keyboard });
}

async function showBotControlAdmin(userId) {
  const enabled = await getBotEnabled();
  const status = await getText(userId, enabled ? 'botEnabledStatus' : 'botDisabledStatus');
  const allowedIds = await getAllowedUserIds();
  const idsText = allowedIds.length ? allowedIds.join(', ') : '-';
  const keyboard = {
    inline_keyboard: [
      [{ text: await getText(userId, enabled ? 'disableBot' : 'enableBot'), callback_data: 'admin_toggle_bot_enabled' }],
      [{ text: await getText(userId, 'botAllowedUsers'), callback_data: 'admin_set_allowed_users' }],
      [{ text: await getText(userId, 'back'), callback_data: 'admin' }]
    ]
  };
  await bot.sendMessage(
    userId,
    `${await getText(userId, 'botStatusLine', { status })}\n${await getText(userId, 'currentAllowedUsers', { ids: idsText })}`,
    { reply_markup: keyboard }
  );
}

async function showBalanceManagementAdmin(userId) {
  const keyboard = {
    inline_keyboard: [
      [{ text: await getText(userId, 'usersWithBalance'), callback_data: 'admin_users_with_balance' }],
      [{ text: await getText(userId, 'addBalanceAdmin'), callback_data: 'admin_add_balance' }],
      [{ text: await getText(userId, 'deductBalanceAdmin'), callback_data: 'admin_deduct_balance' }],
      [{ text: await getText(userId, 'back'), callback_data: 'admin' }]
    ]
  };
  await bot.sendMessage(userId, await getText(userId, 'balanceManagement'), { reply_markup: keyboard });
}


async function showChannelConfigAdmin(userId) {
  const config = await getChannelConfig();
  const statusText = config.enabled
    ? await getText(userId, 'verificationEnabled')
    : await getText(userId, 'verificationDisabled');

  const msg =
    `📢 *${await getText(userId, 'manageChannel')}*\n\n` +
    `⚙️ ${await getText(userId, 'verificationStatus', { status: statusText })}\n` +
    `🔗 ${await getText(userId, 'currentChannelLink', { link: config.link || 'Not set' })}\n` +
    `🆔 Channel ID: ${config.chatId || 'Not resolved yet'}\n` +
    `👤 Username: ${config.username || 'Not resolved yet'}\n` +
    `🏷️ Title: ${config.title || 'Not resolved yet'}\n` +
    `📝 ${await getText(userId, 'currentChannelMessage', { message: config.messageText || 'Not set' })}\n\n` +
    `${await getText(userId, 'channelHelpText')}`;

  const toggleText = config.enabled
    ? await getText(userId, 'disableVerification')
    : await getText(userId, 'enableVerification');

  const keyboard = {
    inline_keyboard: [
      [{ text: toggleText, callback_data: 'admin_toggle_verification' }],
      [{ text: await getText(userId, 'setChannelLink'), callback_data: 'admin_set_channel_link' }],
      [{ text: await getText(userId, 'setChannelMessage'), callback_data: 'admin_set_channel_message' }],
      [{ text: await getText(userId, 'back'), callback_data: 'admin' }]
    ]
  };

  await bot.sendMessage(userId, msg, { parse_mode: 'Markdown', reply_markup: keyboard });
}



async function showMerchantsForBuy(userId) {
  const merchants = await Merchant.findAll({ order: [['category', 'ASC'], ['id', 'ASC']] });
  if (!merchants.length) {
    await bot.sendMessage(userId, await getText(userId, 'noCodes'));
    return sendMainMenu(userId);
  }

  const user = await User.findByPk(userId);
  const grouped = {};
  for (const merchant of merchants) {
    if (!grouped[merchant.category]) grouped[merchant.category] = [];
    grouped[merchant.category].push(merchant);
  }

  const buttons = [];
  for (const [category, list] of Object.entries(grouped)) {
    buttons.push([{ text: `📂 ${category}`, callback_data: 'ignore' }]);
    for (const m of list) {
      const row = [{
        text: `${user.lang === 'en' ? m.nameEn : m.nameAr} - ${m.price} USD`,
        callback_data: `buy_merchant_${m.id}`
      }];
      if (m.description && (m.description.content || m.description.fileId)) {
        row.push({ text: await getText(userId, 'showDescription'), callback_data: `show_description_${m.id}` });
      }
      buttons.push(row);
    }
  }

  buttons.push([{ text: await getText(userId, 'back'), callback_data: 'back_to_menu' }]);
  const chooseText = `${await getText(userId, 'chooseMerchant')}

${await getBulkDiscountInfoText(userId)}`;
  await bot.sendMessage(userId, chooseText, {
    reply_markup: { inline_keyboard: buttons }
  });
}



async function showBotsList(userId) {
  const bots = await BotService.findAll();
  if (!bots.length) {
    await bot.sendMessage(userId, 'No bots found.');
  } else {
    for (const b of bots) {
      const keyboard = {
        inline_keyboard: [
          [
            { text: '➕ Grant /code', callback_data: `bot_grant_code_${b.id}` },
            { text: '👑 Grant Full', callback_data: `bot_grant_full_${b.id}` },
            { text: '❌ Remove Permissions', callback_data: `bot_remove_perms_${b.id}` }
          ],
          [{ text: '🗑️ Delete Bot', callback_data: `admin_remove_bot_confirm_${b.id}` }]
        ]
      };

      await bot.sendMessage(
        userId,
        `🤖 *${b.name}*\nID: ${b.id}\nAllowed: ${(b.allowedActions || []).join(', ') || 'none'}\nOwner: ${b.ownerId || 'none'}`,
        { parse_mode: 'Markdown', reply_markup: keyboard }
      );
    }
  }

  await bot.sendMessage(userId, '➕ Add Bot', {
    reply_markup: { inline_keyboard: [[{ text: '➕ Add Bot', callback_data: 'admin_add_bot' }]] }
  });
}

async function showRedeemServicesAdmin(userId) {
  const services = await RedeemService.findAll();
  let msg = `${await getText(userId, 'listRedeemServices')}\n`;
  for (const s of services) {
    msg += `ID: ${s.id} | ${s.nameEn} / ${s.nameAr} | MerchantDict: ${s.merchantDictId}\n`;
  }

  const keyboard = {
    inline_keyboard: [
      [{ text: await getText(userId, 'addRedeemService'), callback_data: 'admin_add_redeem_service' }],
      [{ text: await getText(userId, 'deleteRedeemService'), callback_data: 'admin_delete_redeem_service' }],
      [{ text: await getText(userId, 'back'), callback_data: 'admin' }]
    ]
  };

  await bot.sendMessage(userId, msg, { reply_markup: keyboard });
}

async function showDiscountCodesAdmin(userId) {
  const codes = await DiscountCode.findAll();
  let msg = `${await getText(userId, 'listDiscountCodes')}\n`;
  if (!codes.length) {
    msg += await getText(userId, 'noDiscountCodes');
  } else {
    for (const c of codes) {
      msg += `ID: ${c.id} | ${c.code} | ${c.discountPercent}% | Uses: ${c.usedCount}/${c.maxUses} | Expires: ${c.validUntil ? c.validUntil.toISOString().split('T')[0] : 'never'}\n`;
    }
  }

  const keyboard = {
    inline_keyboard: [
      [{ text: await getText(userId, 'addDiscountCode'), callback_data: 'admin_add_discount_code' }],
      [{ text: await getText(userId, 'deleteDiscountCode'), callback_data: 'admin_delete_discount_code' }],
      [{ text: await getText(userId, 'back'), callback_data: 'admin' }]
    ]
  };

  await bot.sendMessage(userId, msg, { reply_markup: keyboard });
}

async function redeemCard(cardKey, merchantDictId, platformId = '1') {
  try {
    const apiKey = process.env.NODE_CARD_API_KEY;
    const baseUrl = process.env.NODE_CARD_BASE_URL || 'https://api.node-card.com';
    const params = new URLSearchParams();
    params.append('card_key', cardKey);
    params.append('merchant_dict_id', merchantDictId);
    params.append('platform_id', platformId);
    if (apiKey) params.append('api_key', apiKey);

    const response = await axios.post(`${baseUrl}/api/open/card/redeem`, params, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 10000
    });

    if (response.data && response.data.code === 1) {
      return { success: true, data: response.data.data };
    }
    return { success: false, reason: response.data?.msg || 'Unknown error' };
  } catch (error) {
    console.error('Redeem API error:', error.response?.data || error.message);
    return { success: false, reason: error.response?.data?.msg || error.message || 'API connection failed' };
  }
}

async function redeemCardSmart(cardKey) {
  const services = await RedeemService.findAll();
  if (!services.length) return { success: false, reason: 'No redeem services configured' };

  const preferredNames = ['Amazon', 'Walmart', 'Target'];
  const preferred = [];
  const others = [];

  for (const s of services) {
    const en = (s.nameEn || '').toLowerCase();
    const ar = (s.nameAr || '').toLowerCase();
    const isPreferred = preferredNames.some(name => {
      const n = name.toLowerCase();
      return en.includes(n) || ar.includes(n);
    });
    if (isPreferred) preferred.push(s);
    else others.push(s);
  }

  const ordered = [...preferred, ...others];
  let lastReason = 'No compatible merchant found';
  for (const service of ordered) {
    const result = await redeemCard(cardKey, service.merchantDictId, service.platformId || '1');
    if (result.success) return { success: true, data: result.data, service };
    lastReason = result.reason || lastReason;
  }

  return { success: false, reason: lastReason };
}

function formatCardDetails(cardData) {
  return `💳 ${cardData.card_number}\nCVV: ${cardData.cvv}\nEXP: ${cardData.exp}\n💰 ${cardData.available_amount}\n🏪 ${cardData.merchant_name}`;
}

async function applyDiscount(discountCode, totalAmount) {
  const discount = await DiscountCode.findOne({
    where: {
      code: discountCode,
      [Op.or]: [{ validUntil: null }, { validUntil: { [Op.gt]: new Date() } }]
    }
  });

  if (!discount) return { success: false, reason: 'invalid' };
  if (discount.usedCount >= discount.maxUses) return { success: false, reason: 'maxed' };

  const newTotal = totalAmount * (1 - discount.discountPercent / 100);
  discount.usedCount += 1;
  await discount.save();
  return { success: true, newTotal, discountPercent: discount.discountPercent };
}

async function processPurchase(userId, merchantId, quantity, discountCode = null) {
  const merchant = await Merchant.findByPk(merchantId);
  if (!merchant) return { success: false, reason: 'Merchant not found' };

  const unitPrice = await getPerCodePriceForQuantity(merchant.price, quantity);
  let totalCost = unitPrice * quantity;
  let discountPercent = 0;
  if (discountCode) {
    const disc = await applyDiscount(discountCode, totalCost);
    if (!disc.success) return { success: false, reason: 'Invalid discount code' };
    totalCost = disc.newTotal;
    discountPercent = disc.discountPercent;
  }

  const user = await User.findByPk(userId);
  if (!user) return { success: false, reason: 'User not found' };

  const currentBalance = parseFloat(user.balance);
  if (currentBalance < totalCost) {
    return {
      success: false,
      reason: 'Insufficient balance',
      balance: currentBalance,
      price: unitPrice,
      totalCost
    };
  }

  const codes = await Code.findAll({
    where: { merchantId, isUsed: false },
    limit: quantity,
    order: [['id', 'ASC']]
  });

  if (codes.length < quantity) return { success: false, reason: 'Not enough codes in stock' };

  const t = await sequelize.transaction();
  try {
    await User.update({ balance: currentBalance - totalCost, totalPurchases: user.totalPurchases + quantity }, {
      where: { id: userId },
      transaction: t
    });

    await BalanceTransaction.create({
      userId,
      amount: -totalCost,
      type: 'purchase',
      status: 'completed'
    }, { transaction: t });

    await Code.update({ isUsed: true, usedBy: userId, soldAt: new Date() }, {
      where: { id: codes.map(c => c.id) },
      transaction: t
    });

    await t.commit();
    const codesText = codes.map(c => c.extra ? `${c.value}\n${c.extra}` : c.value).join('\n\n');
    return { success: true, codes: codesText, discountApplied: discountPercent, unitPrice, totalCost };
  } catch (err) {
    await t.rollback();
    console.error('Purchase transaction error:', err);
    return { success: false, reason: 'Database error' };
  }
}

async function requestDeposit(userId, amount, currency, message, imageFileId = null, tgUser = null) {
  const now = new Date();
  const deposit = await BalanceTransaction.create({
    userId,
    amount,
    type: 'deposit',
    status: 'pending',
    imageFileId,
    caption: message,
    txid: currency,
    lastReminderAt: now
  });

  const config = await getDepositConfig(currency);
  const parts = formatDateParts(new Date());
  const usernameText = tgUser?.username ? `@${tgUser.username}` : 'لا يوجد';
  const fullName = [tgUser?.first_name, tgUser?.last_name].filter(Boolean).join(' ').trim() || 'لا يوجد';
  const amountUSD = Number(amount).toFixed(2);
  const amountIQD = Number(amount * config.rate).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
  const currencyDisplay = currency === 'USD'
    ? `${config.displayNameAr || 'بايننس'} / ${config.displayNameEn || 'Binance'}`
    : `${config.displayNameAr || 'دينار عراقي'} / ${config.displayNameEn || 'Iraqi Dinar'}`;

  const notifText =
    `💳 طلب شحن جديد\n\n` +
    `المعرف: ${usernameText}\n` +
    `الاسم: ${fullName}\n` +
    `الايدي: ${userId}\n\n` +
    `العملة المختارة: ${currencyDisplay}\n` +
    `المبلغ بالدولار: ${amountUSD} USD\n` +
    `المبلغ بالدينار: ${amountIQD} IQD\n\n` +
    `الرسالة: ${String(message || '').trim() || 'No message'}\n\n` +
    `السنة: ${parts.year}\n` +
    `الشهر: ${parts.month}\n` +
    `اليوم: ${parts.day}\n` +
    `الساعة: ${parts.hour}:${parts.minute}:${parts.second}`;

  let receiptMsg;
  if (imageFileId) {
    receiptMsg = await bot.sendPhoto(ADMIN_ID, imageFileId, { caption: notifText });
  } else {
    receiptMsg = await bot.sendMessage(ADMIN_ID, notifText);
  }
  await bot.pinChatMessage(ADMIN_ID, receiptMsg.message_id, { disable_notification: true }).catch(() => {});

  const adminMsg = await bot.sendMessage(
    ADMIN_ID,
    `${await getText(ADMIN_ID, 'approve')} / ${await getText(ADMIN_ID, 'reject')}`,
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: await getText(ADMIN_ID, 'approve'), callback_data: `approve_deposit_${deposit.id}` }],
          [{ text: await getText(ADMIN_ID, 'reject'), callback_data: `reject_deposit_${deposit.id}` }]
        ]
      }
    }
  );

  deposit.adminMessageId = adminMsg.message_id;
  await deposit.save();
  return { success: true, depositId: deposit.id };
}

async function approveDeposit(depositId, adminId) {
  if (!isAdmin(adminId)) return false;
  const deposit = await BalanceTransaction.findByPk(depositId);
  if (!deposit || deposit.status !== 'pending') return false;

  const t = await sequelize.transaction();
  try {
    deposit.status = 'completed';
    await deposit.save({ transaction: t });

    const user = await User.findByPk(deposit.userId);
    const newBalance = parseFloat(user.balance) + parseFloat(deposit.amount);
    await User.update({ balance: newBalance }, { where: { id: deposit.userId }, transaction: t });

    await t.commit();
    await bot.sendMessage(deposit.userId, await getText(deposit.userId, 'depositSuccess', {
      balance: newBalance.toFixed(2)
    }));
    await bot.unpinChatMessage(ADMIN_ID).catch(() => {});
    return true;
  } catch (err) {
    await t.rollback();
    console.error('Approve deposit error:', err);
    return false;
  }
}

async function rejectDeposit(depositId, adminId) {
  if (!isAdmin(adminId)) return false;
  const deposit = await BalanceTransaction.findByPk(depositId);
  if (!deposit || deposit.status !== 'pending') return false;
  deposit.status = 'rejected';
  await deposit.save();
  await bot.sendMessage(deposit.userId, await getText(deposit.userId, 'depositRejected'));
  await bot.unpinChatMessage(ADMIN_ID).catch(() => {});
  return true;
}

const CHATGPT_PAGE_URL = 'https://www.bbvadescuentos.mx/develop/openai-3msc';
const CHATGPT_POST_URL = 'https://www.bbvadescuentos.mx/admin-site/php/_httprequest.php';
const CHATGPT_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36',
  Origin: 'https://www.bbvadescuentos.mx',
  Referer: CHATGPT_PAGE_URL,
  Accept: 'application/json, text/plain, */*'
};

let chatGptCookieCache = { cookies: null, fetchedAt: 0 };

function buildCookieHeader(cookieMap = {}) {
  return Object.entries(cookieMap)
    .filter(([, value]) => value !== undefined && value !== null && String(value).length > 0)
    .map(([key, value]) => `${key}=${value}`)
    .join('; ');
}

function parseSetCookie(setCookieHeaders = []) {
  const cookieMap = {};
  for (const item of setCookieHeaders) {
    const [pair] = String(item).split(';');
    const eqIndex = pair.indexOf('=');
    if (eqIndex > 0) {
      const key = pair.slice(0, eqIndex).trim();
      const value = pair.slice(eqIndex + 1).trim();
      cookieMap[key] = value;
    }
  }
  return cookieMap;
}

function getFallbackChatGptCookies() {
  const fallback = {};
  if (process.env.CHATGPT_AK_BMSC) fallback.ak_bmsc = process.env.CHATGPT_AK_BMSC;
  if (process.env.CHATGPT_BM_SV) fallback.bm_sv = process.env.CHATGPT_BM_SV;
  return fallback;
}

async function refreshChatGPTCookies(force = false) {
  const now = Date.now();
  if (!force && chatGptCookieCache.cookies && now - chatGptCookieCache.fetchedAt < 5 * 60 * 1000) {
    return chatGptCookieCache.cookies;
  }

  try {
    const response = await axios.get(CHATGPT_PAGE_URL, {
      timeout: 15000,
      headers: CHATGPT_HEADERS,
      validateStatus: () => true
    });

    const cookies = parseSetCookie(response.headers['set-cookie'] || []);
    const merged = { ...getFallbackChatGptCookies(), ...cookies };
    chatGptCookieCache = { cookies: merged, fetchedAt: now };
    return merged;
  } catch (err) {
    console.error('Failed to refresh ChatGPT cookies:', err.message);
    const fallback = getFallbackChatGptCookies();
    chatGptCookieCache = { cookies: fallback, fetchedAt: now };
    return fallback;
  }
}

async function getChatGPTCode(email) {
  const attempt = async (forceRefresh = false) => {
    const cookies = await refreshChatGPTCookies(forceRefresh);
    const cookieHeader = buildCookieHeader(cookies);

    const form = new FormData();
    form.append('assignOpenAICode', 'true');
    form.append('email', email);

    return axios.post(CHATGPT_POST_URL, form, {
      timeout: 20000,
      maxBodyLength: Infinity,
      headers: {
        ...CHATGPT_HEADERS,
        ...form.getHeaders(),
        Cookie: cookieHeader
      },
      validateStatus: () => true
    });
  };

  try {
    let response = await attempt(false);
    if (response.status === 403 || response.status === 429) {
      response = await attempt(true);
    }

    if (response.status !== 200) {
      return { success: false, reason: `HTTP ${response.status}` };
    }

    const data = response.data || {};
    if (data.success === 1 && data.code) {
      return { success: true, code: data.code };
    }

    return { success: false, reason: data.message || 'Unknown error' };
  } catch (err) {
    console.error('ChatGPT API error:', err.response?.data || err.message);
    return { success: false, reason: err.message || 'Request failed' };
  }
}

async function getOrCreateChatGptMerchant() {
  let merchant = await Merchant.findOne({ where: { nameEn: 'ChatGPT Code' } });
  if (!merchant) {
    merchant = await Merchant.create({
      nameEn: 'ChatGPT Code',
      nameAr: 'كود ChatGPT',
      price: 5.00,
      category: 'AI Services',
      type: 'single',
      description: { type: 'text', content: 'Get a ChatGPT GO code via email' }
    });
  }
  return merchant;
}

async function processAutoChatGptCode(userId, options = {}) {
  const { isFree = false, fromPoints = false, quantity = 1 } = options;
  const safeQuantity = Math.max(1, parseInt(quantity, 10) || 1);
  let merchant = null;
  let currentBalance = 0;
  let price = 0;

  if (!isFree) {
    merchant = await getOrCreateChatGptMerchant();
    price = await getPerCodePriceForQuantity(merchant.price, safeQuantity);
    const userObj = await User.findByPk(userId);
    currentBalance = parseFloat(userObj.balance);

    const totalCost = price * safeQuantity;
    if (currentBalance < totalCost) {
      return {
        success: false,
        reason: 'INSUFFICIENT_BALANCE',
        balance: currentBalance.toFixed(2),
        price: price.toFixed(2),
        totalCost: totalCost.toFixed(2),
        quantity: safeQuantity
      };
    }
  }

  const codes = [];
  let lastFailureReason = null;

  for (let i = 0; i < safeQuantity; i += 1) {
    const email = generateRandomEmail();
    const result = await getChatGPTCode(email);

    if (!result.success) {
      lastFailureReason = result.reason || 'Unknown error';
      const remaining = safeQuantity - codes.length;
      const fallbackCodes = await takeFallbackChatGptCodesFromReferralStock(userId, remaining);
      if (fallbackCodes.length > 0) {
        codes.push(...fallbackCodes);
      }
      break;
    }

    codes.push(result.code);
  }

  if (codes.length === 0) {
    return { success: false, reason: lastFailureReason || 'No codes were generated' };
  }

  if (isFree) {
    if (!fromPoints) {
      await User.update({ freeChatgptReceived: true, lastFreeCodeClaimAt: new Date() }, { where: { id: userId } });
    }
  } else {
    const chargedAmount = price * codes.length;
    await User.update({ balance: currentBalance - chargedAmount }, { where: { id: userId } });
    await BalanceTransaction.create({ userId, amount: -chargedAmount, type: 'purchase', status: 'completed' });
  }

  return {
    success: true,
    code: codes.join('\n\n'),
    codes,
    quantity: codes.length,
    requestedQuantity: safeQuantity,
    partial: codes.length !== safeQuantity,
    price: price.toFixed(2),
    totalCost: (price * codes.length).toFixed(2)
  };
}

bot.onText(/\/start(?:\s+(.+))?/, async (msg, match) => {
  const userId = msg.chat.id;
  const rawArg = match?.[1] ? match[1].trim() : '';

  try {
    const existedBeforeStart = await User.findByPk(userId);
    const isActuallyNewUser = !existedBeforeStart;

    const currentUser = await findOrCreateUser(userId);
    if (!isAdmin(userId) && !(await getBotEnabled()) && !(await isUserAllowedWhenBotStopped(userId))) {
      await bot.sendMessage(userId, await getText(userId, 'botPausedMessage'));
      return;
    }
    const tgUser = msg.from || {};
    const usernameText = tgUser.username ? `@${tgUser.username}` : 'لا يوجد';
    const fullName = [tgUser.first_name, tgUser.last_name].filter(Boolean).join(' ').trim() || 'لا يوجد';

    let fromReferrerName = null;
    let fromReferrerCount = null;
    let fromReferrerUsername = 'لا يوجد';
    let fromReferrerId = null;
    let shouldNotifyReferrer = false;
    let actualReferrerId = null;

    if (rawArg) {
      let referrerId = null;
      if (/^\d+$/.test(rawArg)) {
        referrerId = parseInt(rawArg, 10);
      } else if (rawArg.startsWith('ref_')) {
        const legacyCode = rawArg.substring(4);
        const referrer = await User.findOne({ where: { referralCode: legacyCode } });
        if (referrer) referrerId = Number(referrer.id);
      }

      if (referrerId && referrerId !== Number(userId)) {
        const referrer = await User.findByPk(referrerId);
        if (referrer) {
          actualReferrerId = referrerId;

          if (!currentUser.referredBy) {
            await User.update({ referredBy: referrerId }, { where: { id: userId } });
            shouldNotifyReferrer = true;
          }

          const refIdentity = await getTelegramIdentityById(referrerId);
          fromReferrerName = refIdentity.fullName;
          fromReferrerUsername = refIdentity.usernameText;
          fromReferrerId = referrerId;
          fromReferrerCount = await User.count({ where: { referredBy: referrerId } });
        }
      }
    }

    if (userId !== ADMIN_ID && isActuallyNewUser) {
      let adminNotice =
        `مستخدم جديد\n` +
        `معرفه: ${usernameText}\n` +
        `اسمه: ${fullName}\n` +
        `ايديه: ${userId}`;

      if (fromReferrerName) {
        adminNotice += `\n\nمن طرف: ${fromReferrerName}`;
        adminNotice += `\nعدد الاحالات: ${fromReferrerCount}`;
        adminNotice += `\nمعرفه: ${fromReferrerUsername}`;
        adminNotice += `\nايديه: ${fromReferrerId}`;
      }

      await bot.sendMessage(ADMIN_ID, adminNotice).catch(() => {});
    }

    if (shouldNotifyReferrer && actualReferrerId) {
      const refCountNow = await User.count({ where: { referredBy: actualReferrerId } });
      const referrerNotice =
        `🎉 دخل مستخدم جديد من رابط إحالتك\n` +
        `المعرف: ${usernameText}\n` +
        `الاسم: ${fullName}\n` +
        `الايدي: ${userId}\n\n` +
        `إجمالي الإحالات من رابطك: ${refCountNow}`;
      await bot.sendMessage(actualReferrerId, referrerNotice).catch(() => {});
    }

    await tryAwardReferralIfEligible(userId);

    await bot.sendMessage(userId, await getText(userId, 'start'), {
      reply_markup: {
        inline_keyboard: [
          [{ text: '🇺🇸 English', callback_data: 'lang_en' }],
          [{ text: '🇮🇶 العربية', callback_data: 'lang_ar' }]
        ]
      }
    });
  } catch (err) {
    console.error('Error in /start:', err);
  }
});

bot.onText(/\/admin/, async msg => {
  const userId = msg.chat.id;
  if (!isAdmin(userId)) return;
  await showAdminPanel(userId);
});

bot.on('callback_query', async query => {
  const userId = query.message.chat.id;
  const data = query.data;

  try {
    await findOrCreateUser(userId);

    if (!isAdmin(userId) && !(await getBotEnabled())) {
      await bot.answerCallbackQuery(query.id).catch(() => {});
      await bot.sendMessage(userId, await getText(userId, 'botPausedMessage')).catch(() => {});
      return;
    }

    if (data.startsWith('lang_')) {
      const newLang = data.split('_')[1];
      await User.update({ lang: newLang }, { where: { id: userId } });
      const canUse = await ensureUserAccess(userId, { sendJoinPrompt: true, sendCaptchaPrompt: true });
      if (canUse) {
        await tryAwardReferralIfEligible(userId);
        await sendMainMenu(userId);
      }
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === 'check_subscription') {
      const canUse = await ensureUserAccess(userId, { sendJoinPrompt: true, sendCaptchaPrompt: true });
      if (canUse) {
        await tryAwardReferralIfEligible(userId);
        await sendMainMenu(userId);
      }
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === 'ignore') {
      await bot.answerCallbackQuery(query.id);
      return;
    }

    const canUse = await ensureUserAccess(userId, { sendJoinPrompt: true, sendCaptchaPrompt: false });
    if (!canUse) {
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === 'back_to_menu') {
      await sendMainMenu(userId);
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === 'support') {
      await setUserState(userId, { action: 'support' });
      await bot.sendMessage(userId, await getText(userId, 'sendReply'));
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data.startsWith('support_reply_user_')) {
      const adminId = parseInt(data.split('_')[3], 10);
      await setUserState(userId, { action: 'support_reply_user', targetAdminId: adminId });
      await bot.sendMessage(userId, await getText(userId, 'sendReply'));
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === 'admin' && isAdmin(userId)) {
      await showAdminPanel(userId);
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === 'admin_section_products' && isAdmin(userId)) {
      await showAdminProductsSection(userId);
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === 'admin_add_product_section' && isAdmin(userId)) {
      await setUserState(userId, { action: 'add_product_section', step: 'nameEn' });
      await bot.sendMessage(userId, await getText(userId, 'enterSectionNameEn'));
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === 'admin_manage_product_sections' && isAdmin(userId)) {
      const sections = await getProductSections();
      if (!sections.length) {
        await bot.sendMessage(userId, await getText(userId, 'noProductSections'));
      } else {
        const keyboard = [];
        for (const section of sections) {
          keyboard.push([{ text: await getLocalizedSectionName(userId, section), callback_data: `admin_manage_section_${section.key}` }]);
        }
        keyboard.push([{ text: await getText(userId, 'back'), callback_data: 'admin_section_products' }]);
        await bot.sendMessage(userId, await getText(userId, 'productSectionsTitle'), { reply_markup: { inline_keyboard: keyboard } });
      }
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === 'chatgpt_code') {
      await showFrontSection(userId, 'gpt');
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data.startsWith('front_section_')) {
      const sectionKey = data.substring('front_section_'.length);
      await showFrontSection(userId, sectionKey);
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data.startsWith('admin_manage_section_') && isAdmin(userId)) {
      const sectionKey = data.substring('admin_manage_section_'.length);
      await showSectionAdmin(userId, sectionKey);
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data.startsWith('admin_rename_section_') && isAdmin(userId)) {
      const sectionKey = data.substring('admin_rename_section_'.length);
      await setUserState(userId, { action: 'rename_product_section', step: 'nameEn', sectionKey });
      await bot.sendMessage(userId, await getText(userId, 'enterSectionNameEn'));
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data.startsWith('admin_delete_section_') && isAdmin(userId)) {
      const sectionKey = data.substring('admin_delete_section_'.length);
      if (sectionKey === 'gpt') {
        await bot.sendMessage(userId, await getText(userId, 'cannotDeleteGptSection'));
      } else {
        await deleteProductSectionByKey(sectionKey);
        await bot.sendMessage(userId, await getText(userId, 'sectionDeleted'));
      }
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data.startsWith('admin_section_add_product_') && isAdmin(userId)) {
      const sectionKey = data.substring('admin_section_add_product_'.length);
      await setUserState(userId, { action: 'add_merchant', step: 'nameEn', presetCategory: sectionKey });
      await bot.sendMessage(userId, await getText(userId, 'askMerchantNameEn'));
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data.startsWith('admin_section_manage_products_') && isAdmin(userId)) {
      const sectionKey = data.substring('admin_section_manage_products_'.length);
      await showSectionProductsAdmin(userId, sectionKey);
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data.startsWith('admin_rename_product_') && isAdmin(userId)) {
      const merchantId = parseInt(data.substring('admin_rename_product_'.length), 10);
      await setUserState(userId, { action: 'rename_section_product', step: 'nameEn', merchantId });
      await bot.sendMessage(userId, await getText(userId, 'askMerchantNameEn'));
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data.startsWith('admin_delete_product_') && isAdmin(userId)) {
      const merchantId = parseInt(data.substring('admin_delete_product_'.length), 10);
      await Merchant.destroy({ where: { id: merchantId } });
      await Code.destroy({ where: { merchantId } });
      await bot.sendMessage(userId, await getText(userId, 'productDeleted'));
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data.startsWith('admin_toggle_feature_') && isAdmin(userId)) {
      const rest = data.substring('admin_toggle_feature_'.length);
      const splitIndex = rest.lastIndexOf('_');
      const sectionKey = rest.substring(0, splitIndex);
      const merchantId = parseInt(rest.substring(splitIndex + 1), 10);
      await toggleFeaturedProduct(sectionKey, merchantId);
      await bot.sendMessage(userId, await getText(userId, 'featuredUpdated'));
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === 'admin_manage_channel' && isAdmin(userId)) {
      await showChannelConfigAdmin(userId);
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === 'admin_toggle_verification' && isAdmin(userId)) {
      const config = await getChannelConfig();
      if (!config.enabled) {
        const hasTarget = Boolean(config.chatId || config.username || parseChannelTarget(config.link));
        if (!hasTarget) {
          await bot.answerCallbackQuery(query.id, { text: await getText(userId, 'verificationNeedsChannel'), show_alert: true });
          return;
        }
      }

      config.enabled = !config.enabled;
      await config.save();

      await bot.answerCallbackQuery(query.id, {
        text: await getText(userId, config.enabled ? 'verificationToggledOn' : 'verificationToggledOff')
      });
      await showChannelConfigAdmin(userId);
      return;
    }

    if (data === 'admin_set_channel_link' && isAdmin(userId)) {
      await setUserState(userId, { action: 'set_channel_link' });
      await bot.sendMessage(userId, await getText(userId, 'enterNewChannelLink'));
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === 'admin_set_channel_message' && isAdmin(userId)) {
      await setUserState(userId, { action: 'set_channel_message' });
      await bot.sendMessage(userId, await getText(userId, 'enterNewChannelMessage'));
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === 'admin_manage_menu_buttons' && isAdmin(userId)) {
      await showMenuButtonsAdmin(userId);
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data.startsWith('toggle_button_') && isAdmin(userId)) {
      const parts = data.split('_');
      const action = parts.pop();
      const buttonId = parts.slice(2).join('_');
      await toggleMenuButton(buttonId, action);
      await bot.answerCallbackQuery(query.id, { text: await getText(userId, 'buttonVisibilityUpdated') });
      await showMenuButtonsAdmin(userId);
      return;
    }

    if (data.startsWith('move_button_') && isAdmin(userId)) {
      const parts = data.split('_');
      const direction = parts.pop();
      const buttonId = parts.slice(2).join('_');
      await moveMenuButton(buttonId, direction);
      await bot.answerCallbackQuery(query.id, { text: await getText(userId, 'buttonOrderUpdated') });
      await showMenuButtonsAdmin(userId);
      return;
    }

    if (data.startsWith('support_reply_') && isAdmin(userId)) {
      const targetUserId = parseInt(data.split('_')[2], 10);
      await setUserState(userId, { action: 'support_reply', targetUserId });
      await bot.sendMessage(userId, await getText(userId, 'replyToSupport', { userId: targetUserId }));
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === 'my_balance') {
      const user = await User.findByPk(userId);
      await bot.sendMessage(userId, `💰 ${parseFloat(user.balance).toFixed(2)} USD`);
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === 'referral') {
      const user = await User.findByPk(userId);
      const link = await getUserReferralLink(userId);
      const points = Number(user?.referralPoints || 0);
      const requiredPoints = await getEffectiveRedeemPointsForUser(userId);
      const redeemableCodes = await getRedeemableReferralCodesCount(userId);
      const info = await getText(userId, 'referralInfo', { link, points, requiredPoints, redeemableCodes });

      const freeCodeButtonRow = (await canUserClaimFreeCode(userId)) && !user?.freeChatgptReceived
        ? [[{ text: await getText(userId, 'getFreeCode'), callback_data: 'get_free_code' }]]
        : [];

      const keyboard = {
        inline_keyboard: [
          [{ text: await getText(userId, 'redeemPoints'), callback_data: 'redeem_points' }],
          ...freeCodeButtonRow,
          [{ text: await getText(userId, 'back'), callback_data: 'back_to_menu' }]
        ]
      };

      await bot.sendMessage(userId, info, { parse_mode: 'Markdown', reply_markup: keyboard });
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === 'redeem_points') {
      const user = await User.findByPk(userId);
      const requiredPoints = await getEffectiveRedeemPointsForUser(userId);

      if (Number(user.referralPoints || 0) < requiredPoints) {
        await bot.sendMessage(userId, await getText(userId, 'notEnoughPoints', { points: user.referralPoints, requiredPoints }));
        await bot.answerCallbackQuery(query.id);
        return;
      }

      await setUserState(userId, { action: 'redeem_points_amount' });
      await bot.sendMessage(userId, await getText(userId, 'redeemPointsAskAmount', { requiredPoints }));
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === 'referral_free_code' || data === 'free_code') {
      const canClaim = await canUserClaimFreeCode(userId);

      if (!canClaim) {
        await sendMainMenu(userId);
        await bot.answerCallbackQuery(query.id);
        return;
      }

      const waitingMsg = await bot.sendMessage(userId, await getText(userId, 'processing'));
      const result = await processAutoChatGptCode(userId, { isFree: true, fromPoints: false });
      await bot.deleteMessage(userId, waitingMsg.message_id).catch(() => {});

      if (result.success) {
        {
        const deliveryPrefix = await getCodeDeliveryPrefixHtml(userId);
        await bot.sendMessage(userId, `${deliveryPrefix}${await getText(userId, 'freeCodeSuccess', { code: formatCodesForHtml(result.codes) })}`, { parse_mode: 'HTML' });
      }
      } else {
        await bot.sendMessage(userId, `${await getText(userId, 'error')}: ${result.reason}`);
      }

      await sendMainMenu(userId);
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === 'discount') {
      await setUserState(userId, { action: 'discount' });
      await bot.sendMessage(userId, await getText(userId, 'enterDiscountCode'));
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === 'my_purchases') {
      const purchases = await BalanceTransaction.findAll({
        where: { userId, type: 'purchase', status: 'completed' },
        order: [['createdAt', 'DESC']],
        limit: 20
      });

      if (!purchases.length) {
        await bot.sendMessage(userId, await getText(userId, 'noPurchases'));
      } else {
        const history = purchases.map(p => `🛒 ${p.createdAt.toLocaleDateString()}: ${p.amount} USD`).join('\n');
        await bot.sendMessage(userId, await getText(userId, 'purchaseHistory', { history }));
      }
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === 'deposit') {
      await showCurrencyOptions(userId);
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === 'deposit_currency_iqd') {
      await setUserState(userId, { action: 'deposit_amount', currency: 'IQD' });
      await bot.sendMessage(userId, '💰 USD:');
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === 'deposit_currency_usd') {
      await setUserState(userId, { action: 'deposit_amount', currency: 'USD' });
      await bot.sendMessage(userId, '💰 USD:');
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === 'admin_manage_bots' && isAdmin(userId)) {
      await showBotsList(userId);
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === 'admin_add_bot' && isAdmin(userId)) {
      await setUserState(userId, { action: 'add_bot', step: 'token' });
      await bot.sendMessage(userId, await getText(userId, 'enterBotToken'));
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data.startsWith('bot_grant_code_') && isAdmin(userId)) {
      const botId = parseInt(data.split('_')[3], 10);
      const botService = await BotService.findByPk(botId);
      if (botService) {
        const allowed = Array.isArray(botService.allowedActions) ? [...botService.allowedActions] : [];
        if (!allowed.includes('code')) allowed.push('code');
        botService.allowedActions = allowed.filter(a => a !== 'full');
        await botService.save();
        await bot.sendMessage(userId, `✅ Granted /code permission to ${botService.name}`);
      }
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data.startsWith('bot_grant_full_') && isAdmin(userId)) {
      const botId = parseInt(data.split('_')[3], 10);
      await setUserState(userId, { action: 'set_bot_owner', botId });
      await bot.sendMessage(userId, 'Send the Telegram user ID of the new bot owner:');
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data.startsWith('bot_remove_perms_') && isAdmin(userId)) {
      const botId = parseInt(data.split('_')[3], 10);
      const botService = await BotService.findByPk(botId);
      if (botService) {
        botService.allowedActions = [];
        botService.ownerId = null;
        await botService.save();
        await bot.sendMessage(userId, `❌ Removed all permissions from ${botService.name}`);
      }
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data.startsWith('admin_remove_bot_confirm_') && isAdmin(userId)) {
      const botId = parseInt(data.split('_')[4], 10);
      await BotService.destroy({ where: { id: botId } });
      await bot.sendMessage(userId, await getText(userId, 'botRemoved'));
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data.startsWith('approve_deposit_') && isAdmin(userId)) {
      const depositId = parseInt(data.split('_')[2], 10);
      await approveDeposit(depositId, userId);
      await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: userId, message_id: query.message.message_id }).catch(() => {});
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data.startsWith('reject_deposit_') && isAdmin(userId)) {
      const depositId = parseInt(data.split('_')[2], 10);
      await rejectDeposit(depositId, userId);
      await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: userId, message_id: query.message.message_id }).catch(() => {});
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === 'buy') {
      await showMerchantsForBuy(userId);
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === 'redeem') {
      await setUserState(userId, { action: 'redeem_smart' });
      await bot.sendMessage(userId, await getText(userId, 'sendCodeToRedeem'));
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data.startsWith('redeem_service_')) {
      const serviceId = parseInt(data.split('_')[2], 10);
      await setUserState(userId, { action: 'redeem_via_service', serviceId });
      await bot.sendMessage(userId, await getText(userId, 'sendCodeToRedeem'));
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data.startsWith('buy_merchant_')) {
      const merchantId = parseInt(data.split('_')[2], 10);
      const available = await Code.count({ where: { merchantId, isUsed: false } });
      if (!available) {
        await bot.sendMessage(userId, await getText(userId, 'noCodes'));
        await sendMainMenu(userId);
        await bot.answerCallbackQuery(query.id);
        return;
      }
      const currentState = safeParseState((await User.findByPk(userId)).state);
      const discountCode = currentState?.discountCode || null;
      await setUserState(userId, { action: 'buy', merchantId, discountCode });
      await bot.sendMessage(userId, `${await getText(userId, 'enterQty')}\n📦 Available: ${available}\n\n${await getBulkDiscountInfoText(userId)}`);
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data.startsWith('show_description_')) {
      const merchantId = parseInt(data.split('_')[2], 10);
      const merchant = await Merchant.findByPk(merchantId);
      if (merchant?.description) {
        const desc = merchant.description;
        if (desc.type === 'text') await bot.sendMessage(userId, desc.content);
        else if (desc.type === 'photo') await bot.sendPhoto(userId, desc.fileId);
        else if (desc.type === 'video') await bot.sendVideo(userId, desc.fileId);
      } else {
        await bot.sendMessage(userId, 'No description available.');
      }
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === 'admin_stats' && isAdmin(userId)) {
      const totalCodes = await Code.count();
      const totalSales = await BalanceTransaction.sum('amount', { where: { type: 'purchase', status: 'completed' } });
      const pendingDeposits = await BalanceTransaction.count({ where: { type: 'deposit', status: 'pending' } });
      await bot.sendMessage(userId,
        `${await getText(userId, 'totalCodes', { count: totalCodes })}\n` +
        `${await getText(userId, 'totalSales', { amount: Math.abs(totalSales || 0) })}\n` +
        `${await getText(userId, 'pendingDeposits', { count: pendingDeposits })}`
      );
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === 'admin_payment_methods' && isAdmin(userId)) {
      const methods = await PaymentMethod.findAll();
      let msg = '💳 Payment Methods:\n';
      for (const m of methods) {
        msg += `ID: ${m.id} | ${m.nameEn} (${m.type}) - Active: ${m.isActive}\n`;
      }
      const keyboard = {
        inline_keyboard: [
          [{ text: '➕ Add New', callback_data: 'admin_add_payment' }],
          [{ text: '🗑️ Delete', callback_data: 'admin_delete_payment' }],
          [{ text: '⚙️ Set Limits', callback_data: 'admin_set_limits' }],
          [{ text: await getText(userId, 'back'), callback_data: 'admin' }]
        ]
      };
      await bot.sendMessage(userId, msg, { reply_markup: keyboard });
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === 'admin_manage_deposit_settings' && isAdmin(userId)) {
      await showDepositSettingsAdmin(userId);
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === 'admin_set_iqd_rate' && isAdmin(userId)) {
      await setUserState(userId, { action: 'set_iqd_rate' });
      await bot.sendMessage(userId, await getText(userId, 'enterNewRate'));
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === 'admin_edit_deposit_instructions' && isAdmin(userId)) {
      await showDepositInstructionsEdit(userId);
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === 'admin_edit_currency_names' && isAdmin(userId)) {
      await showCurrencyNamesEdit(userId);
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if ((data === 'admin_manage_iqd_methods' || data === 'admin_manage_usd_methods') && isAdmin(userId)) {
      const currency = data.includes('iqd') ? 'IQD' : 'USD';
      await showDepositMethodsAdmin(userId, currency);
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if ((data === 'admin_add_deposit_method_IQD' || data === 'admin_add_deposit_method_USD') && isAdmin(userId)) {
      const currency = data.endsWith('IQD') ? 'IQD' : 'USD';
      await setUserState(userId, { action: 'add_deposit_method', currency, step: 'nameAr' });
      await bot.sendMessage(userId, await getText(userId, 'enterMethodNameAr'));
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if ((data === 'admin_delete_deposit_method_menu_IQD' || data === 'admin_delete_deposit_method_menu_USD') && isAdmin(userId)) {
      const currency = data.endsWith('IQD') ? 'IQD' : 'USD';
      await showDeleteDepositMethodsMenu(userId, currency);
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data.startsWith('admin_delete_deposit_method_') && isAdmin(userId)) {
      const parts = data.split('_');
      const currency = parts[4];
      const index = parseInt(parts[5], 10);
      if (!Number.isNaN(index)) {
        await deleteDepositMethod(currency, index);
        await bot.sendMessage(userId, await getText(userId, 'methodDeleted'));
        await showDepositMethodsAdmin(userId, currency);
      }
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data.startsWith('admin_edit_name_') && isAdmin(userId)) {
      const parts = data.split('_');
      const currency = parts[3];
      const langCode = parts[4];
      await setUserState(userId, { action: 'edit_currency_name', currency, langCode });
      await bot.sendMessage(userId, await getText(userId, 'enterNewCurrencyName'));
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data.startsWith('admin_edit_template_') && isAdmin(userId)) {
      const parts = data.split('_');
      const currency = parts[3];
      const langCode = parts[4];
      await setUserState(userId, { action: 'edit_deposit_template', currency, langCode });
      await bot.sendMessage(userId, await getText(userId, 'enterNewTemplate'));
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === 'admin_add_merchant' && isAdmin(userId)) {
      await setUserState(userId, { action: 'add_merchant', step: 'nameEn' });
      await bot.sendMessage(userId, await getText(userId, 'askMerchantNameEn'));
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === 'admin_list_merchants' && isAdmin(userId)) {
      const merchants = await Merchant.findAll();
      let msg = await getText(userId, 'merchantList');
      for (const m of merchants) {
        msg += `ID: ${m.id} | ${m.nameEn} / ${m.nameAr} | Price: ${m.price} USD | Category: ${m.category} | Type: ${m.type}\n`;
      }
      const keyboard = {
        inline_keyboard: [
          [{ text: '✏️ Edit', callback_data: 'admin_edit_merchant' }],
          [{ text: '🗑️ Delete', callback_data: 'admin_delete_merchant' }],
          [{ text: '📂 Edit Category', callback_data: 'admin_edit_category' }],
          [{ text: await getText(userId, 'back'), callback_data: 'admin' }]
        ]
      };
      await bot.sendMessage(userId, msg, { reply_markup: keyboard });
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === 'admin_set_chatgpt_price' && isAdmin(userId)) {
      await setUserState(userId, { action: 'set_chatgpt_price' });
      await bot.sendMessage(userId, await getText(userId, 'enterChatgptPrice'));
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === 'admin_set_price' && isAdmin(userId)) {
      const merchants = await Merchant.findAll();
      const buttons = merchants.map(m => ([{ text: `${m.nameEn} (ID: ${m.id})`, callback_data: `set_price_merchant_${m.id}` }]));
      buttons.push([{ text: await getText(userId, 'back'), callback_data: 'admin' }]);
      await bot.sendMessage(userId, await getText(userId, 'setPrice'), { reply_markup: { inline_keyboard: buttons } });
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data.startsWith('set_price_merchant_') && isAdmin(userId)) {
      const merchantId = parseInt(data.split('_')[3], 10);
      await setUserState(userId, { action: 'set_price', merchantId });
      await bot.sendMessage(userId, await getText(userId, 'enterPrice'));
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === 'admin_add_codes' && isAdmin(userId)) {
      const merchants = await Merchant.findAll();
      const buttons = merchants.map(m => ([{ text: `${m.nameEn} (ID: ${m.id})`, callback_data: `add_codes_merchant_${m.id}` }]));
      buttons.push([{ text: await getText(userId, 'back'), callback_data: 'admin' }]);
      await bot.sendMessage(userId, await getText(userId, 'addCodes'), { reply_markup: { inline_keyboard: buttons } });
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data.startsWith('add_codes_merchant_') && isAdmin(userId)) {
      const merchantId = parseInt(data.split('_')[3], 10);
      await setUserState(userId, { action: 'add_codes', merchantId });
      await bot.sendMessage(userId, await getText(userId, 'enterCodes'));
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === 'admin_referral_settings' && isAdmin(userId)) {
      await showReferralSettingsAdmin(userId);
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === 'admin_referral_eligible_users' && isAdmin(userId)) {
      const eligible = await getEligibleReferralUsers(1);
      if (!eligible.length) {
        await bot.sendMessage(userId, await getText(userId, 'noReferralEligibleUsers'));
      } else {
        let msgText = `${await getText(userId, 'referralEligibleUsersTitle')}\n\n`;
        for (const item of eligible.slice(0, 100)) {
          const identity = await getTelegramIdentityById(item.user.id);
          msgText += await getText(userId, 'referralEligibleUserLine', {
            name: identity.fullName,
            username: identity.usernameText,
            id: item.user.id,
            points: item.totalPoints,
            adminGranted: item.adminGranted,
            referrals: item.referralCount,
            milestoneRewards: item.milestoneRewards,
            claimedCodes: item.claimedCodes,
            redeemableCodes: item.redeemableCodes
          });
          msgText += `\n\n`;
        }
        await bot.sendMessage(userId, msgText);
      }
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === 'admin_deduct_points' && isAdmin(userId)) {
      await setUserState(userId, { action: 'deduct_points', step: 'user_id' });
      await bot.sendMessage(userId, await getText(userId, 'enterDeductPointsUserId'));
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === 'admin_referral_stock_settings' && isAdmin(userId)) {
      await showReferralStockSettingsAdmin(userId);
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === 'admin_add_referral_stock_codes' && isAdmin(userId)) {
      await setUserState(userId, { action: 'add_referral_stock_codes' });
      await bot.sendMessage(userId, await getText(userId, 'enterReferralStockCodes'));
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === 'admin_view_referral_stock_count' && isAdmin(userId)) {
      const merchant = await getReferralStockMerchant();
      const count = await Code.count({ where: { merchantId: merchant.id, isUsed: false } });
      await bot.sendMessage(userId, await getText(userId, 'referralStockCountText', { count }));
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === 'admin_toggle_referrals' && isAdmin(userId)) {
      const current = await getReferralEnabled();
      await Setting.upsert({ key: 'referral_enabled', lang: 'global', value: String(!current) });
      await bot.sendMessage(userId, await getText(userId, !current ? 'referralsTurnedOn' : 'referralsTurnedOff'));
      await showReferralSettingsAdmin(userId);
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === 'admin_set_allowed_users' && isAdmin(userId)) {
      await setUserState(userId, { action: 'set_allowed_users' });
      await bot.sendMessage(userId, await getText(userId, 'enterAllowedUsers'));
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === 'referral_prize' || data === 'referral_stock_claim') {
      const referralCount = await getSuccessfulReferralCount(userId);
      if (referralCount <= 0) {
        await bot.sendMessage(userId, await getText(userId, 'referralStockAccessDenied'));
      } else {
        const maxCodes = await getRedeemableReferralCodesCount(userId);
        if (maxCodes <= 0) {
          await bot.sendMessage(userId, await getText(userId, 'notEnoughPoints', {
            points: (await User.findByPk(userId))?.referralPoints || 0,
            requiredPoints: await getEffectiveRedeemPointsForUser(userId)
          }));
        } else {
          await setUserState(userId, { action: 'claim_referral_stock' });
          await bot.sendMessage(userId, await getText(userId, 'referralClaimAskCount', { maxCodes }));
        }
      }
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === 'admin_set_referral_percent' && isAdmin(userId)) {
      await setUserState(userId, { action: 'set_referral_percent' });
      await bot.sendMessage(userId, await getText(userId, 'setReferralPercent'));
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === 'admin_set_redeem_points' && isAdmin(userId)) {
      await setUserState(userId, { action: 'set_redeem_points' });
      await bot.sendMessage(userId, await getText(userId, 'enterRedeemPoints'));
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === 'admin_set_free_code_days' && isAdmin(userId)) {
      await setUserState(userId, { action: 'set_free_code_days' });
      await bot.sendMessage(userId, await getText(userId, 'enterFreeCodeDays'));
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === 'admin_edit_referral_milestones' && isAdmin(userId)) {
      await setUserState(userId, { action: 'edit_referral_milestones' });
      await bot.sendMessage(userId, await getText(userId, 'enterReferralMilestones'));
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === 'admin_quantity_discount_settings' && isAdmin(userId)) {
      await showQuantityDiscountSettingsAdmin(userId);
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === 'admin_set_bulk_discount_threshold' && isAdmin(userId)) {
      await setUserState(userId, { action: 'set_bulk_discount_threshold' });
      await bot.sendMessage(userId, await getText(userId, 'enterBulkDiscountThreshold'));
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === 'admin_set_bulk_discount_price' && isAdmin(userId)) {
      await setUserState(userId, { action: 'set_bulk_discount_price' });
      await bot.sendMessage(userId, await getText(userId, 'enterBulkDiscountPrice'));
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === 'admin_bot_control' && isAdmin(userId)) {
      await showBotControlAdmin(userId);
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === 'admin_balance_management' && isAdmin(userId)) {
      await showBalanceManagementAdmin(userId);
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === 'admin_users_with_balance' && isAdmin(userId)) {
      const users = await User.findAll({
        where: { balance: { [Op.gt]: 0 } },
        order: [['balance', 'DESC']],
        limit: 100
      });
      if (!users.length) {
        await bot.sendMessage(userId, await getText(userId, 'noUsersWithBalance'));
      } else {
        let msgText = `${await getText(userId, 'usersWithBalanceTitle')}\n\n`;
        for (const u of users) {
          const identity = await getTelegramIdentityById(u.id);
          msgText += await getText(userId, 'balanceUserLine', {
            name: identity.fullName,
            username: identity.usernameText,
            id: u.id,
            balance: Number(u.balance || 0).toFixed(2)
          });
          msgText += `\n\n`;
        }
        await bot.sendMessage(userId, msgText);
      }
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === 'admin_add_balance' && isAdmin(userId)) {
      await setUserState(userId, { action: 'admin_add_balance', step: 'user_id' });
      await bot.sendMessage(userId, await getText(userId, 'enterBalanceUserId'));
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === 'admin_deduct_balance' && isAdmin(userId)) {
      await setUserState(userId, { action: 'admin_deduct_balance', step: 'user_id' });
      await bot.sendMessage(userId, await getText(userId, 'enterBalanceUserId'));
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === 'admin_toggle_bot_enabled' && isAdmin(userId)) {
      const enabled = await getBotEnabled();
      await Setting.upsert({ key: 'bot_enabled', lang: 'global', value: enabled ? 'false' : 'true' });
      await bot.sendMessage(userId, await getText(userId, enabled ? 'botTurnedOff' : 'botTurnedOn'));
      await showBotControlAdmin(userId);
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === 'admin_grant_creator_discount' && isAdmin(userId)) {
      await setUserState(userId, { action: 'grant_creator_discount', step: 'user_id' });
      await bot.sendMessage(userId, await getText(userId, 'enterCreatorDiscountUserId'));
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === 'admin_grant_points' && isAdmin(userId)) {
      await setUserState(userId, { action: 'grant_points', step: 'user_id' });
      await bot.sendMessage(userId, await getText(userId, 'enterGrantPointsUserId'));
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === 'admin_manage_redeem_services' && isAdmin(userId)) {
      await showRedeemServicesAdmin(userId);
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === 'admin_add_redeem_service' && isAdmin(userId)) {
      await setUserState(userId, { action: 'add_redeem_service', step: 'nameEn' });
      await bot.sendMessage(userId, await getText(userId, 'redeemServiceNameEn'));
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === 'admin_delete_redeem_service' && isAdmin(userId)) {
      const services = await RedeemService.findAll();
      const buttons = services.map(s => ([{ text: `${s.nameEn} (ID: ${s.id})`, callback_data: `delete_redeem_service_${s.id}` }]));
      buttons.push([{ text: await getText(userId, 'back'), callback_data: 'admin_manage_redeem_services' }]);
      await bot.sendMessage(userId, 'Select service to delete:', { reply_markup: { inline_keyboard: buttons } });
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data.startsWith('delete_redeem_service_') && isAdmin(userId)) {
      const serviceId = parseInt(data.split('_')[3], 10);
      await RedeemService.destroy({ where: { id: serviceId } });
      await bot.sendMessage(userId, 'Service deleted.');
      await showRedeemServicesAdmin(userId);
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === 'admin_manage_discount_codes' && isAdmin(userId)) {
      await showDiscountCodesAdmin(userId);
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === 'admin_send_announcement' && isAdmin(userId)) {
      await setUserState(userId, { action: 'broadcast_announcement' });
      await bot.sendMessage(userId, await getText(userId, 'enterAnnouncementText'));
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === 'admin_edit_code_delivery_message' && isAdmin(userId)) {
      await bot.sendMessage(userId, await getText(userId, 'chooseCodeMessageLanguage'), {
        reply_markup: {
          inline_keyboard: [
            [{ text: await getText(userId, 'codeMessageArabic'), callback_data: 'admin_edit_code_message_ar' }],
            [{ text: await getText(userId, 'codeMessageEnglish'), callback_data: 'admin_edit_code_message_en' }],
            [{ text: await getText(userId, 'back'), callback_data: 'admin' }]
          ]
        }
      });
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === 'admin_edit_code_message_ar' && isAdmin(userId)) {
      await setUserState(userId, { action: 'edit_code_delivery_message', targetLang: 'ar' });
      await bot.sendMessage(userId, await getText(userId, 'enterCodeDeliveryMessage'));
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === 'admin_edit_code_message_en' && isAdmin(userId)) {
      await setUserState(userId, { action: 'edit_code_delivery_message', targetLang: 'en' });
      await bot.sendMessage(userId, await getText(userId, 'enterCodeDeliveryMessage'));
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === 'admin_add_discount_code' && isAdmin(userId)) {
      await setUserState(userId, { action: 'add_discount_code', step: 'code' });
      await bot.sendMessage(userId, await getText(userId, 'enterDiscountCodeValue'));
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === 'admin_delete_discount_code' && isAdmin(userId)) {
      const codes = await DiscountCode.findAll();
      const buttons = codes.map(c => ([{ text: `${c.code} (${c.discountPercent}%)`, callback_data: `delete_discount_code_${c.id}` }]));
      buttons.push([{ text: await getText(userId, 'back'), callback_data: 'admin_manage_discount_codes' }]);
      await bot.sendMessage(userId, 'Select discount code to delete:', { reply_markup: { inline_keyboard: buttons } });
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data.startsWith('delete_discount_code_') && isAdmin(userId)) {
      const codeId = parseInt(data.split('_')[3], 10);
      await DiscountCode.destroy({ where: { id: codeId } });
      await bot.sendMessage(userId, await getText(userId, 'discountCodeDeleted'));
      await showDiscountCodesAdmin(userId);
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === 'admin_edit_merchant' && isAdmin(userId)) {
      const merchants = await Merchant.findAll();
      const buttons = merchants.map(m => ([{ text: `${m.nameEn} (ID: ${m.id})`, callback_data: `edit_merchant_${m.id}` }]));
      buttons.push([{ text: await getText(userId, 'back'), callback_data: 'admin_list_merchants' }]);
      await bot.sendMessage(userId, 'Select merchant to edit:', { reply_markup: { inline_keyboard: buttons } });
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data.startsWith('edit_merchant_') && isAdmin(userId)) {
      const merchantId = parseInt(data.split('_')[2], 10);
      await setUserState(userId, { action: 'edit_merchant', merchantId, step: 'nameEn' });
      await bot.sendMessage(userId, 'Send new English name (or /skip):');
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === 'admin_delete_merchant' && isAdmin(userId)) {
      const merchants = await Merchant.findAll();
      const buttons = merchants.map(m => ([{ text: `${m.nameEn} (ID: ${m.id})`, callback_data: `delete_merchant_${m.id}` }]));
      buttons.push([{ text: await getText(userId, 'back'), callback_data: 'admin_list_merchants' }]);
      await bot.sendMessage(userId, 'Select merchant to delete:', { reply_markup: { inline_keyboard: buttons } });
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data.startsWith('delete_merchant_') && isAdmin(userId)) {
      const merchantId = parseInt(data.split('_')[2], 10);
      await setUserState(userId, { action: 'confirm_delete_merchant', merchantId });
      await bot.sendMessage(userId, await getText(userId, 'confirmDelete'), {
        reply_markup: {
          inline_keyboard: [
            [{ text: await getText(userId, 'yes'), callback_data: `confirm_delete_merchant_yes_${merchantId}` }],
            [{ text: await getText(userId, 'no'), callback_data: 'admin_list_merchants' }]
          ]
        }
      });
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data.startsWith('confirm_delete_merchant_yes_') && isAdmin(userId)) {
      const merchantId = parseInt(data.split('_')[4], 10);
      await Merchant.destroy({ where: { id: merchantId } });
      await bot.sendMessage(userId, await getText(userId, 'merchantDeleted'));
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === 'admin_edit_category' && isAdmin(userId)) {
      const merchants = await Merchant.findAll();
      const buttons = merchants.map(m => ([{ text: `${m.nameEn} (ID: ${m.id})`, callback_data: `edit_category_${m.id}` }]));
      buttons.push([{ text: await getText(userId, 'back'), callback_data: 'admin_list_merchants' }]);
      await bot.sendMessage(userId, 'Select merchant to edit category:', { reply_markup: { inline_keyboard: buttons } });
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data.startsWith('edit_category_') && isAdmin(userId)) {
      const merchantId = parseInt(data.split('_')[2], 10);
      await setUserState(userId, { action: 'edit_category', merchantId });
      await bot.sendMessage(userId, await getText(userId, 'askCategory'));
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === 'admin_add_payment' && isAdmin(userId)) {
      await setUserState(userId, { action: 'add_payment_method', step: 'nameEn' });
      await bot.sendMessage(userId, 'Send payment method name in English:');
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === 'admin_delete_payment' && isAdmin(userId)) {
      const methods = await PaymentMethod.findAll();
      const buttons = methods.map(m => ([{ text: `${m.nameEn} (ID: ${m.id})`, callback_data: `delete_payment_${m.id}` }]));
      buttons.push([{ text: await getText(userId, 'back'), callback_data: 'admin_payment_methods' }]);
      await bot.sendMessage(userId, 'Select payment method to delete:', { reply_markup: { inline_keyboard: buttons } });
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data.startsWith('delete_payment_') && isAdmin(userId)) {
      const paymentId = parseInt(data.split('_')[2], 10);
      await PaymentMethod.destroy({ where: { id: paymentId } });
      await bot.sendMessage(userId, 'Payment method deleted.');
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === 'admin_set_limits' && isAdmin(userId)) {
      const methods = await PaymentMethod.findAll();
      const buttons = methods.map(m => ([{ text: `${m.nameEn} (ID: ${m.id})`, callback_data: `set_limits_${m.id}` }]));
      buttons.push([{ text: await getText(userId, 'back'), callback_data: 'admin_payment_methods' }]);
      await bot.sendMessage(userId, 'Select payment method to set limits:', { reply_markup: { inline_keyboard: buttons } });
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data.startsWith('set_limits_') && isAdmin(userId)) {
      const methodId = parseInt(data.split('_')[2], 10);
      await setUserState(userId, { action: 'set_limits', methodId, step: 'min' });
      await bot.sendMessage(userId, 'Enter minimum deposit amount (USD):');
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data.startsWith('merchant_type_')) {
      const state = safeParseState((await User.findByPk(userId)).state);
      if (state?.action === 'add_merchant' && state.step === 'type') {
        const selectedType = data.replace('merchant_type_', '');
        await setUserState(userId, { ...state, selectedType, step: 'description' });
        await bot.sendMessage(userId, await getText(userId, 'askDescription'));
      }
      await bot.answerCallbackQuery(query.id);
      return;
    }

    if (data === 'chatgpt_direct_buy') {
      await setUserState(userId, { action: 'chatgpt_buy_quantity' });
      await bot.sendMessage(userId, `${await getText(userId, 'askQuantity')}\n\n${await getBulkDiscountInfoText(userId)}`);
      await bot.answerCallbackQuery(query.id);
      return;
    }

    await bot.answerCallbackQuery(query.id);
  } catch (err) {
    console.error('Callback error:', err);
    await bot.answerCallbackQuery(query.id, { text: 'Error occurred' }).catch(() => {});
  }
});

bot.on('message', async msg => {
  const userId = msg.chat.id;
  const text = msg.text;
  const photo = msg.photo;
  const video = msg.video;

  try {
    const user = await User.findByPk(userId);
    if (!user) return;
    if (!isAdmin(userId) && !(await getBotEnabled()) && !(await isUserAllowedWhenBotStopped(userId))) {
      await bot.sendMessage(userId, await getText(userId, 'botPausedMessage'));
      return;
    }
    let state = safeParseState(user.state);

    const verificationRequired = await isVerificationRequiredForUser(userId);

    if (verificationRequired && !user.verified) {
      const captcha = await Captcha.findByPk(userId);
      if (captcha) {
        const ok = await verifyCaptcha(userId, text || '');
        if (ok) {
          await handleVerificationSuccess(userId);
        } else if (text) {
          await bot.sendMessage(userId, await getText(userId, 'captchaWrong'));
          const challenge = await createCaptcha(userId);
          await bot.sendMessage(userId, await getText(userId, 'captchaChallenge', { challenge }));
        }
        return;
      }

      const isMember = await checkChannelMembership(userId);
      if (!isMember) {
        await sendJoinChannelMessage(userId);
        return;
      }

      const challenge = await createCaptcha(userId);
      await bot.sendMessage(userId, await getText(userId, 'captchaChallenge', { challenge }));
      return;
    }

    if (verificationRequired) {
      const stillMember = await checkChannelMembership(userId);
      if (!stillMember) {
        if (user.verified) {
          user.verified = false;
          await user.save();
        }
        await Captcha.destroy({ where: { userId } });
        await sendJoinChannelMessage(userId);
        return;
      }
    }

    if (state && isAdmin(userId)) {
      if (state.action === 'set_channel_link') {
        let resolved = null;

        if (msg.forward_from_chat && msg.forward_from_chat.type === 'channel') {
          const forwardedChat = msg.forward_from_chat;
          resolved = {
            ok: true,
            chatId: String(forwardedChat.id),
            username: forwardedChat.username ? `@${forwardedChat.username}` : null,
            title: forwardedChat.title || forwardedChat.username || String(forwardedChat.id),
            link: forwardedChat.username ? `https://t.me/${forwardedChat.username}` : null,
            type: 'channel'
          };
        } else {
          const rawInput = String(text || '').trim();
          resolved = await resolveChannelTarget(rawInput);
        }

        if (!resolved || !resolved.ok) {
          await bot.sendMessage(userId, `❌ ${resolved?.message || 'Invalid channel value.'}`);
          return;
        }

        if (resolved.type && resolved.type !== 'channel') {
          await bot.sendMessage(userId, '❌ The target must be a Telegram channel, not a group.');
          return;
        }

        const config = await getChannelConfig();
        config.link = resolved.link || config.link || null;
        config.chatId = resolved.chatId;
        config.username = resolved.username;
        config.title = resolved.title;
        await config.save();

        await bot.sendMessage(userId, await getText(userId, 'channelLinkSet'));
        await setUserState(userId, null);
        await showChannelConfigAdmin(userId);
        return;
      }

      if (state.action === 'set_channel_message') {
        const config = await getChannelConfig();
        config.messageText = String(text || '').trim();
        await config.save();
        await bot.sendMessage(userId, await getText(userId, 'channelMessageSet'));
        await clearUserState(userId);
        await showChannelConfigAdmin(userId);
        return;
      }
    }

    if (state?.action === 'support_reply' && isAdmin(userId)) {
      const targetUserId = state.targetUserId;
      const replyMsg = text || '';
      let fileId = null;
      if (photo) fileId = photo[photo.length - 1].file_id;
      else if (video) fileId = video.file_id;

      const supportReplyText = `${await getText(userId, 'replyMessage')}\n\n${replyMsg}`;
      if (fileId) {
        if (photo) await bot.sendPhoto(targetUserId, fileId, { caption: supportReplyText });
        else await bot.sendVideo(targetUserId, fileId, { caption: supportReplyText });
      } else {
        await bot.sendMessage(targetUserId, supportReplyText);
      }

      const replyButton = { inline_keyboard: [[{ text: await getText(targetUserId, 'replyToSupport'), callback_data: `support_reply_user_${userId}` }]] };
      await bot.sendMessage(targetUserId, await getText(targetUserId, 'replyToSupport'), { reply_markup: replyButton });
      await bot.sendMessage(userId, await getText(userId, 'supportMessageSent'));
      await clearUserState(userId);
      return;
    }

    if (state?.action === 'support_reply_user') {
      const targetAdminId = state.targetAdminId;
      const supportText = text || '';
      const photoFileId = photo ? photo[photo.length - 1].file_id : null;
      const notifText = await getText(targetAdminId, 'supportNotification', {
        userId,
        username: msg.from?.username ? `@${msg.from.username}` : 'لا يوجد',
        name: [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(' ').trim() || 'لا يوجد',
        message: supportText || 'No message'
      });
      if (photoFileId) {
        await bot.sendPhoto(targetAdminId, photoFileId, { caption: notifText });
      } else {
        await bot.sendMessage(targetAdminId, notifText);
      }
      await bot.sendMessage(userId, await getText(userId, 'supportMessageSent'));
      await clearUserState(userId);
      return;
    }

    if (state && isAdmin(userId)) {
      if (state.action === 'add_bot' && state.step === 'token') {
        try {
          const testBot = new TelegramBot(text, { polling: false });
          const me = await testBot.getMe();
          await BotService.create({ token: text, name: me.username, allowedActions: [] });
          await bot.sendMessage(userId, await getText(userId, 'botAdded'));
          await showBotsList(userId);
        } catch {
          await bot.sendMessage(userId, '❌ Invalid token');
        }
        await clearUserState(userId);
        return;
      }

      if (state.action === 'set_bot_owner') {
        const ownerId = parseInt(text, 10);
        if (Number.isNaN(ownerId)) {
          await bot.sendMessage(userId, '❌ Invalid user ID');
        } else {
          const botService = await BotService.findByPk(state.botId);
          if (botService) {
            botService.ownerId = ownerId;
            botService.allowedActions = ['full'];
            await botService.save();
            await bot.sendMessage(userId, `✅ Granted full permissions to user ${ownerId} for bot ${botService.name}`);
          } else {
            await bot.sendMessage(userId, 'Bot not found');
          }
        }
        await clearUserState(userId);
        return;
      }


      if (state.action === 'add_product_section') {
        if (state.step === 'nameEn') {
          await setUserState(userId, { ...state, nameEn: text, step: 'nameAr' });
          await bot.sendMessage(userId, await getText(userId, 'enterSectionNameAr'));
          return;
        }
        if (state.step === 'nameAr') {
          const sectionKey = await addProductSection(state.nameEn, text);
          await bot.sendMessage(userId, await getText(userId, 'sectionAdded'));
          await clearUserState(userId);
          await showSectionAdmin(userId, sectionKey);
          return;
        }
      }

      if (state.action === 'rename_product_section') {
        if (state.step === 'nameEn') {
          await setUserState(userId, { ...state, nameEn: text, step: 'nameAr' });
          await bot.sendMessage(userId, await getText(userId, 'enterSectionNameAr'));
          return;
        }
        if (state.step === 'nameAr') {
          await updateProductSection(state.sectionKey, { nameEn: state.nameEn, nameAr: text });
          await bot.sendMessage(userId, await getText(userId, 'sectionNameUpdated'));
          await clearUserState(userId);
          await showSectionAdmin(userId, state.sectionKey);
          return;
        }
      }

      if (state.action === 'rename_section_product') {
        const merchant = await Merchant.findByPk(state.merchantId);
        if (!merchant) {
          await bot.sendMessage(userId, 'Merchant not found');
          await clearUserState(userId);
          return;
        }
        if (state.step === 'nameEn') {
          merchant.nameEn = text;
          await merchant.save();
          await setUserState(userId, { ...state, step: 'nameAr' });
          await bot.sendMessage(userId, await getText(userId, 'askMerchantNameAr'));
          return;
        }
        if (state.step === 'nameAr') {
          merchant.nameAr = text;
          await merchant.save();
          await bot.sendMessage(userId, await getText(userId, 'productUpdated'));
          const sectionKey = merchant.category === 'AI Services' ? 'gpt' : (merchant.category || 'general');
          await clearUserState(userId);
          await showSectionProductsAdmin(userId, sectionKey);
          return;
        }
      }

      if (state.action === 'add_merchant') {
        if (state.step === 'nameEn') {
          await setUserState(userId, { ...state, nameEn: text, step: 'nameAr' });
          await bot.sendMessage(userId, await getText(userId, 'askMerchantNameAr'));
          return;
        }

        if (state.step === 'nameAr') {
          await setUserState(userId, { ...state, nameAr: text, step: 'price' });
          await bot.sendMessage(userId, await getText(userId, 'askMerchantPrice'));
          return;
        }

        if (state.step === 'price') {
          const price = parseFloat(text);
          if (Number.isNaN(price)) {
            await bot.sendMessage(userId, '❌ Invalid price');
            return;
          }
          await setUserState(userId, { ...state, price, step: 'type' });
          await bot.sendMessage(userId, await getText(userId, 'askMerchantType'), {
            reply_markup: {
              inline_keyboard: [
                [{ text: await getText(userId, 'typeCodeSingle'), callback_data: 'merchant_type_code_single' }],
                [{ text: await getText(userId, 'typeAccountSingle'), callback_data: 'merchant_type_account_single' }],
                [{ text: await getText(userId, 'typeAccountVerifySingle'), callback_data: 'merchant_type_account_verify_single' }],
                [{ text: await getText(userId, 'typeAccountBulk'), callback_data: 'merchant_type_account_bulk' }],
                [{ text: await getText(userId, 'typeAccountVerifyBulk'), callback_data: 'merchant_type_account_verify_bulk' }]
              ]
            }
          });
          return;
        }

        if (state.step === 'description') {
          let description = null;
          if (text === '/skip') description = null;
          else if (text) description = { type: 'text', content: text };
          else if (photo) description = { type: 'photo', fileId: photo[photo.length - 1].file_id };
          else if (video) description = { type: 'video', fileId: video.file_id };
          else {
            await bot.sendMessage(userId, 'Please send text, photo, video, or /skip');
            return;
          }

          const merchant = await Merchant.create({
            nameEn: state.nameEn,
            nameAr: state.nameAr,
            price: state.price,
            category: state.presetCategory || state.category || 'general',
            type: state.selectedType || 'code_single',
            description
          });

          await bot.sendMessage(userId, await getText(userId, 'merchantCreated', { id: merchant.id }));
          await clearUserState(userId);
          await showAdminPanel(userId);
          return;
        }
      }

      if (state.action === 'set_chatgpt_price') {
        const price = parseFloat(text);
        if (Number.isNaN(price) || price <= 0) {
          await bot.sendMessage(userId, '❌ Invalid price');
          return;
        }
        const merchant = await getOrCreateChatGptMerchant();
        merchant.price = price;
        await merchant.save();
        await bot.sendMessage(userId, await getText(userId, 'chatgptPriceUpdated', { price }));
        await clearUserState(userId);
        await showAdminPanel(userId);
        return;
      }

      if (state.action === 'set_price') {
        const price = parseFloat(text);
        if (Number.isNaN(price)) {
          await bot.sendMessage(userId, '❌ Invalid price');
          return;
        }
        await Merchant.update({ price }, { where: { id: state.merchantId } });
        await bot.sendMessage(userId, await getText(userId, 'priceUpdated'));
        await clearUserState(userId);
        await showAdminPanel(userId);
        return;
      }

      if (state.action === 'add_codes') {
        const lines = String(text || '').split(/\r?\n/).map(v => v.trim()).filter(Boolean);
        const merchant = await Merchant.findByPk(state.merchantId);
        if (!merchant) {
          await bot.sendMessage(userId, 'Merchant not found');
          await clearUserState(userId);
          return;
        }

        if (merchant.type === 'code_single' || merchant.type === 'single') {
          await Code.bulkCreate(lines.map(value => ({ value, merchantId: merchant.id, isUsed: false })));
        } else if (merchant.type === 'account_single' || merchant.type === 'account_bulk' || merchant.type === 'bulk') {
          if (lines.length % 2 !== 0) {
            await bot.sendMessage(userId, await getText(userId, 'stockFormatAccount'));
            return;
          }
          const items = [];
          for (let i = 0; i < lines.length; i += 2) {
            items.push({ value: lines[i], extra: lines[i + 1], merchantId: merchant.id, isUsed: false });
          }
          await Code.bulkCreate(items);
        } else if (merchant.type === 'account_verify_single' || merchant.type === 'account_verify_bulk') {
          if (lines.length % 3 !== 0) {
            await bot.sendMessage(userId, await getText(userId, 'stockFormatAccountVerify'));
            return;
          }
          const items = [];
          for (let i = 0; i < lines.length; i += 3) {
            items.push({ value: lines[i], extra: `${lines[i + 1]}
${lines[i + 2]}`, merchantId: merchant.id, isUsed: false });
          }
          await Code.bulkCreate(items);
        } else {
          await Code.bulkCreate(lines.map(value => ({ value, merchantId: merchant.id, isUsed: false })));
        }

        await bot.sendMessage(userId, await getText(userId, 'codesAdded'));
        await clearUserState(userId);
        await showAdminPanel(userId);
        return;
      }

      if (state.action === 'edit_merchant') {
        const merchant = await Merchant.findByPk(state.merchantId);
        if (!merchant) {
          await bot.sendMessage(userId, 'Merchant not found');
          await clearUserState(userId);
          return;
        }

        if (state.step === 'nameEn') {
          if (text !== '/skip') merchant.nameEn = text;
          await merchant.save();
          await setUserState(userId, { ...state, step: 'nameAr' });
          await bot.sendMessage(userId, 'Send new Arabic name (or /skip):');
          return;
        }

        if (state.step === 'nameAr') {
          if (text !== '/skip') merchant.nameAr = text;
          await merchant.save();
          await setUserState(userId, { ...state, step: 'price' });
          await bot.sendMessage(userId, 'Send new price (or /skip):');
          return;
        }

        if (state.step === 'price') {
          if (text !== '/skip') {
            const price = parseFloat(text);
            if (!Number.isNaN(price)) merchant.price = price;
          }
          await merchant.save();
          await bot.sendMessage(userId, 'Merchant updated successfully.');
          await clearUserState(userId);
          await showAdminPanel(userId);
          return;
        }
      }

      if (state.action === 'edit_category') {
        const merchant = await Merchant.findByPk(state.merchantId);
        if (merchant) {
          merchant.category = text;
          await merchant.save();
          await bot.sendMessage(userId, await getText(userId, 'categoryUpdated'));
        }
        await clearUserState(userId);
        await showAdminPanel(userId);
        return;
      }

      if (state.action === 'add_payment_method') {
        if (state.step === 'nameEn') {
          await setUserState(userId, { ...state, nameEn: text, step: 'nameAr' });
          await bot.sendMessage(userId, 'Send name in Arabic:');
          return;
        }
        if (state.step === 'nameAr') {
          await setUserState(userId, { ...state, nameAr: text, step: 'details' });
          await bot.sendMessage(userId, 'Send payment details (e.g., wallet address):');
          return;
        }
        if (state.step === 'details') {
          await setUserState(userId, { ...state, details: text, step: 'type' });
          await bot.sendMessage(userId, 'Send type (manual/auto):');
          return;
        }
        if (state.step === 'type') {
          const type = String(text || '').toLowerCase();
          if (!['manual', 'auto'].includes(type)) {
            await bot.sendMessage(userId, 'Type must be manual or auto');
            return;
          }
          await PaymentMethod.create({
            nameEn: state.nameEn,
            nameAr: state.nameAr,
            details: state.details,
            type,
            config: {},
            isActive: true,
            minDeposit: 1,
            maxDeposit: 10000
          });
          await bot.sendMessage(userId, 'Payment method added successfully.');
          await clearUserState(userId);
          await showAdminPanel(userId);
          return;
        }
      }

      if (state.action === 'set_limits') {
        if (state.step === 'min') {
          const min = parseFloat(text);
          if (Number.isNaN(min)) {
            await bot.sendMessage(userId, 'Invalid number');
            return;
          }
          await setUserState(userId, { ...state, min, step: 'max' });
          await bot.sendMessage(userId, 'Enter maximum deposit amount (USD):');
          return;
        }
        if (state.step === 'max') {
          const max = parseFloat(text);
          if (Number.isNaN(max)) {
            await bot.sendMessage(userId, 'Invalid number');
            return;
          }
          const method = await PaymentMethod.findByPk(state.methodId);
          if (method) {
            method.minDeposit = state.min;
            method.maxDeposit = max;
            await method.save();
            await bot.sendMessage(userId, `Limits set: Min ${state.min} USD, Max ${max} USD.`);
          } else {
            await bot.sendMessage(userId, 'Method not found');
          }
          await clearUserState(userId);
          await showAdminPanel(userId);
          return;
        }
      }


      if (state.action === 'broadcast_announcement') {
        const messageText = String(text || '').trim();
        if (!messageText) {
          await bot.sendMessage(userId, await getText(userId, 'enterAnnouncementText'));
          return;
        }

        const stats = await broadcastAnnouncement(messageText);
        await bot.sendMessage(userId, await getText(userId, 'announcementSent', stats));
        await clearUserState(userId);
        await showAdminPanel(userId);
        return;
      }

      if (state.action === 'edit_code_delivery_message') {
        const targetLang = state.targetLang === 'ar' ? 'ar' : 'en';
        const value = String(text || '').trim() === '/empty' ? '' : String(text || '');
        await Setting.upsert({ key: 'code_delivery_message', lang: targetLang, value });
        await bot.sendMessage(userId, await getText(userId, 'codeDeliveryMessageUpdated'));
        await clearUserState(userId);
        await showAdminPanel(userId);
        return;
      }


      if (state.action === 'edit_referral_milestones') {
        const raw = String(text || '').trim();
        const parsedPairs = raw.split(',').map(part => part.trim()).filter(Boolean);
        const normalized = [];
        for (const pair of parsedPairs) {
          const [countStr, bonusStr] = pair.split(':').map(v => String(v || '').trim());
          const count = parseInt(countStr, 10);
          const bonus = parseInt(bonusStr, 10);
          if (!Number.isInteger(count) || count <= 0 || !Number.isInteger(bonus) || bonus <= 0) {
            await bot.sendMessage(userId, await getText(userId, 'enterReferralMilestones'));
            return;
          }
          normalized.push(`${count}:${bonus}`);
        }
        if (!normalized.length) {
          await bot.sendMessage(userId, await getText(userId, 'enterReferralMilestones'));
          return;
        }
        await Setting.upsert({ key: 'referral_milestones', lang: 'global', value: normalized.join(',') });
        await bot.sendMessage(userId, await getText(userId, 'referralMilestonesUpdated'));
        await clearUserState(userId);
        await showReferralSettingsAdmin(userId);
        return;
      }

      if (state.action === 'set_bulk_discount_threshold') {
        const threshold = parseInt(text, 10);
        if (!Number.isInteger(threshold) || threshold <= 0) {
          await bot.sendMessage(userId, await getText(userId, 'enterBulkDiscountThreshold'));
          return;
        }
        await Setting.upsert({ key: 'bulk_discount_threshold', lang: 'global', value: String(threshold) });
        await bot.sendMessage(userId, await getText(userId, 'bulkDiscountSettingsUpdated'));
        await clearUserState(userId);
        await showQuantityDiscountSettingsAdmin(userId);
        return;
      }

      if (state.action === 'set_bulk_discount_price') {
        const price = parseFloat(text);
        if (!Number.isFinite(price) || price <= 0) {
          await bot.sendMessage(userId, await getText(userId, 'enterBulkDiscountPrice'));
          return;
        }
        await Setting.upsert({ key: 'bulk_discount_price', lang: 'global', value: String(price) });
        await bot.sendMessage(userId, await getText(userId, 'bulkDiscountSettingsUpdated'));
        await clearUserState(userId);
        await showQuantityDiscountSettingsAdmin(userId);
        return;
      }

      if (state.action === 'set_referral_percent') {
        const percent = parseFloat(text);
        if (Number.isNaN(percent)) {
          await bot.sendMessage(userId, 'Invalid percentage');
          return;
        }
        await Setting.upsert({ key: 'referral_percent', lang: 'global', value: String(percent) });
        process.env.REFERRAL_PERCENT = String(percent);
        await bot.sendMessage(userId, await getText(userId, 'referralPercentUpdated', { percent }));
        await clearUserState(userId);
        await showReferralSettingsAdmin(userId);
        return;
      }

      if (state.action === 'set_redeem_points') {
        const points = parseInt(text, 10);
        if (!Number.isInteger(points) || points <= 0) {
          await bot.sendMessage(userId, 'Invalid points number');
          return;
        }
        await Setting.upsert({ key: 'referral_redeem_points', lang: 'global', value: String(points) });
        await bot.sendMessage(userId, await getText(userId, 'redeemPointsUpdated', { points }));
        await clearUserState(userId);
        await showReferralSettingsAdmin(userId);
        return;
      }

      if (state.action === 'set_free_code_days') {
        const days = parseInt(text, 10);
        if (!Number.isInteger(days) || days <= 0) {
          await bot.sendMessage(userId, await getText(userId, 'enterFreeCodeDays'));
          return;
        }
        await Setting.upsert({ key: 'free_code_cooldown_days', lang: 'global', value: String(days) });
        await bot.sendMessage(userId, await getText(userId, 'freeCodeDaysUpdated', { days }));
        await clearUserState(userId);
        await showReferralSettingsAdmin(userId);
        return;
      }


      if (state.action === 'set_allowed_users') {
        const value = String(text || '').trim() === '/empty'
          ? ''
          : String(text || '')
              .split(/[\s,]+/)
              .map(v => parseInt(v, 10))
              .filter(v => Number.isInteger(v) && v > 0)
              .join(',');
        await Setting.upsert({ key: 'bot_allowed_user_ids', lang: 'global', value });
        await bot.sendMessage(userId, await getText(userId, 'allowedUsersUpdated'));
        await clearUserState(userId);
        await showBotControlAdmin(userId);
        return;
      }

      if (state.action === 'add_referral_stock_codes') {
        const merchant = await getReferralStockMerchant();
        const lines = String(text || '').split(/\r?\n|\s+/).filter(v => String(v).trim());
        if (!lines.length) {
          await bot.sendMessage(userId, await getText(userId, 'enterReferralStockCodes'));
          return;
        }
        await Code.bulkCreate(lines.map(value => ({ value, merchantId: merchant.id, isUsed: false })));
        await bot.sendMessage(userId, await getText(userId, 'referralStockCodesAdded'));
        await clearUserState(userId);
        await showReferralStockSettingsAdmin(userId);
        return;
      }

      if (state.action === 'deduct_points') {
        if (state.step === 'user_id') {
          const targetUserId = parseInt(text, 10);
          if (!Number.isInteger(targetUserId)) {
            await bot.sendMessage(userId, await getText(userId, 'enterDeductPointsUserId'));
            return;
          }
          const targetUser = await User.findByPk(targetUserId);
          if (!targetUser) {
            await bot.sendMessage(userId, await getText(userId, 'deductPointsUserNotFound'));
            return;
          }
          await setUserState(userId, { action: 'deduct_points', step: 'points', targetUserId });
          await bot.sendMessage(userId, await getText(userId, 'enterDeductPointsAmount'));
          return;
        }

        if (state.step === 'points') {
          const points = parseInt(text, 10);
          if (!Number.isInteger(points) || points <= 0) {
            await bot.sendMessage(userId, await getText(userId, 'enterDeductPointsAmount'));
            return;
          }
          const targetUser = await User.findByPk(state.targetUserId);
          if (!targetUser) {
            await bot.sendMessage(userId, await getText(userId, 'deductPointsUserNotFound'));
            await clearUserState(userId);
            await showReferralSettingsAdmin(userId);
            return;
          }
          targetUser.referralPoints = Math.max(0, Number(targetUser.referralPoints || 0) - points);
          await targetUser.save();
          await bot.sendMessage(userId, await getText(userId, 'deductPointsDone', {
            userId: targetUser.id,
            points: targetUser.referralPoints
          }));
          await clearUserState(userId);
          await showReferralSettingsAdmin(userId);
          return;
        }
      }

      if (state.action === 'claim_referral_stock') {
        const result = await claimReferralStockCodes(userId, text);
        if (!result.success) {
          if (result.reason === 'invalid_count') {
            await bot.sendMessage(userId, await getText(userId, 'referralClaimAskCount', { maxCodes: result.maxCodes || 0 }));
          } else if (result.reason === 'not_enough_stock') {
            await bot.sendMessage(userId, await getText(userId, 'referralStockNotEnough'));
            await clearUserState(userId);
          } else if (result.reason === 'no_referrals') {
            await bot.sendMessage(userId, await getText(userId, 'referralStockAccessDenied'));
            await clearUserState(userId);
          } else {
            await bot.sendMessage(userId, await getText(userId, 'error'));
          }
          return;
        }
        const deliveryPrefix = await getCodeDeliveryPrefixHtml(userId);
        await bot.sendMessage(userId, `${deliveryPrefix}${await getText(userId, 'pointsRedeemed', { code: formatCodesForHtml(result.codes) })}`, { parse_mode: 'HTML' });

        const identity = await getTelegramIdentityById(userId);
        await bot.sendMessage(ADMIN_ID, await getText(ADMIN_ID, 'referralClaimAdminNotice', {
          name: identity.fullName,
          username: identity.usernameText,
          id: userId,
          claimedNow: result.count,
          claimedBefore: result.claimedBefore,
          claimedAfter: result.claimedAfter,
          eligibleNow: result.eligibleNow,
          points: result.points,
          adminGranted: result.adminGranted,
          referrals: result.referralCount,
          milestoneRewards: result.milestoneRewards
        })).catch(() => {});

        await bot.sendMessage(ADMIN_ID, await getText(ADMIN_ID, 'stockClaimAdminShort', {
          name: identity.fullName,
          username: identity.usernameText,
          id: userId,
          count: result.count
        })).catch(() => {});

        await clearUserState(userId);
        await sendMainMenu(userId);
        return;
      }


      if (state.action === 'admin_add_balance') {
        if (state.step === 'user_id') {
          const targetUserId = parseInt(text, 10);
          if (!Number.isInteger(targetUserId)) {
            await bot.sendMessage(userId, await getText(userId, 'enterBalanceUserId'));
            return;
          }
          const targetUser = await User.findByPk(targetUserId);
          if (!targetUser) {
            await bot.sendMessage(userId, await getText(userId, 'balanceUserNotFound'));
            return;
          }
          await setUserState(userId, { action: 'admin_add_balance', step: 'amount', targetUserId });
          await bot.sendMessage(userId, await getText(userId, 'enterBalanceAmount'));
          return;
        }

        if (state.step === 'amount') {
          const amount = parseFloat(text);
          if (!Number.isFinite(amount) || amount <= 0) {
            await bot.sendMessage(userId, await getText(userId, 'balanceAmountInvalid'));
            return;
          }
          const targetUser = await User.findByPk(state.targetUserId);
          if (!targetUser) {
            await bot.sendMessage(userId, await getText(userId, 'balanceUserNotFound'));
            await clearUserState(userId);
            await showBalanceManagementAdmin(userId);
            return;
          }
          const newBalance = Number(targetUser.balance || 0) + amount;
          await User.update({ balance: newBalance }, { where: { id: targetUser.id } });
          await BalanceTransaction.create({
            userId: targetUser.id,
            amount,
            type: 'admin_balance_add',
            status: 'completed'
          });
          await bot.sendMessage(userId, await getText(userId, 'balanceAddedDone', {
            amount: amount.toFixed(2),
            userId: targetUser.id,
            balance: newBalance.toFixed(2)
          }));
          await bot.sendMessage(targetUser.id, await getText(targetUser.id, 'balanceReceivedNotification', {
            amount: amount.toFixed(2),
            balance: newBalance.toFixed(2)
          })).catch(() => {});
          await clearUserState(userId);
          await showBalanceManagementAdmin(userId);
          return;
        }
      }

      if (state.action === 'admin_deduct_balance') {
        if (state.step === 'user_id') {
          const targetUserId = parseInt(text, 10);
          if (!Number.isInteger(targetUserId)) {
            await bot.sendMessage(userId, await getText(userId, 'enterBalanceUserId'));
            return;
          }
          const targetUser = await User.findByPk(targetUserId);
          if (!targetUser) {
            await bot.sendMessage(userId, await getText(userId, 'balanceUserNotFound'));
            return;
          }
          await setUserState(userId, { action: 'admin_deduct_balance', step: 'amount', targetUserId });
          await bot.sendMessage(userId, await getText(userId, 'enterBalanceAmount'));
          return;
        }

        if (state.step === 'amount') {
          const amount = parseFloat(text);
          if (!Number.isFinite(amount) || amount <= 0) {
            await bot.sendMessage(userId, await getText(userId, 'balanceAmountInvalid'));
            return;
          }
          const targetUser = await User.findByPk(state.targetUserId);
          if (!targetUser) {
            await bot.sendMessage(userId, await getText(userId, 'balanceUserNotFound'));
            await clearUserState(userId);
            await showBalanceManagementAdmin(userId);
            return;
          }
          const currentBalance = Number(targetUser.balance || 0);
          const deductAmount = Math.min(currentBalance, amount);
          const newBalance = Math.max(0, currentBalance - deductAmount);
          await User.update({ balance: newBalance }, { where: { id: targetUser.id } });
          await BalanceTransaction.create({
            userId: targetUser.id,
            amount: -deductAmount,
            type: 'admin_balance_deduct',
            status: 'completed'
          });
          await bot.sendMessage(userId, await getText(userId, 'balanceDeductedDone', {
            amount: deductAmount.toFixed(2),
            userId: targetUser.id,
            balance: newBalance.toFixed(2)
          }));
          await bot.sendMessage(targetUser.id, await getText(targetUser.id, 'balanceDeductedNotification', {
            amount: deductAmount.toFixed(2),
            balance: newBalance.toFixed(2)
          })).catch(() => {});
          await clearUserState(userId);
          await showBalanceManagementAdmin(userId);
          return;
        }
      }

      if (state.action === 'grant_points') {
        if (state.step === 'user_id') {
          const targetUserId = parseInt(text, 10);
          if (!Number.isInteger(targetUserId)) {
            await bot.sendMessage(userId, await getText(userId, 'enterGrantPointsUserId'));
            return;
          }

          const targetUser = await User.findByPk(targetUserId);
          if (!targetUser) {
            await bot.sendMessage(userId, await getText(userId, 'grantPointsUserNotFound'));
            return;
          }

          await setUserState(userId, { action: 'grant_points', step: 'points', targetUserId });
          await bot.sendMessage(userId, await getText(userId, 'enterGrantPointsAmount'));
          return;
        }

        if (state.step === 'points') {
          const points = parseInt(text, 10);
          if (!Number.isInteger(points) || points <= 0) {
            await bot.sendMessage(userId, await getText(userId, 'enterGrantPointsAmount'));
            return;
          }

          const targetUser = await User.findByPk(state.targetUserId);
          if (!targetUser) {
            await bot.sendMessage(userId, await getText(userId, 'grantPointsUserNotFound'));
            await clearUserState(userId);
            await showReferralSettingsAdmin(userId);
            return;
          }

          targetUser.referralPoints = (targetUser.referralPoints || 0) + points;
          targetUser.adminGrantedPoints = (targetUser.adminGrantedPoints || 0) + points;
          await targetUser.save();

          const refIdentity = await getTelegramIdentityById(targetUser.id);
          const referralCount = await User.count({ where: { referredBy: targetUser.id, referralRewarded: true } });
          const milestoneRewards = await getCumulativeReferralMilestonePoints(referralCount);

          await bot.sendMessage(
            userId,
            await getText(userId, 'grantPointsDoneDetailed', {
              userId: targetUser.id,
              username: refIdentity.usernameText,
              name: refIdentity.fullName,
              points,
              total: targetUser.referralPoints,
              adminGranted: targetUser.adminGrantedPoints || 0,
              referrals: referralCount,
              milestoneRewards
            })
          );

          try {
            await bot.sendMessage(
              targetUser.id,
              await getText(targetUser.id, 'pointsGrantedNotification', {
                points,
                total: targetUser.referralPoints
              })
            );
          } catch (notifyErr) {
            console.error('Grant points notify error:', notifyErr.message);
          }

          await clearUserState(userId);
          await showReferralSettingsAdmin(userId);
          return;
        }
      }

      if (state.action === 'grant_creator_discount') {
        if (state.step === 'user_id') {
          const targetUserId = parseInt(text, 10);
          if (!Number.isInteger(targetUserId)) {
            await bot.sendMessage(userId, await getText(userId, 'enterCreatorDiscountUserId'));
            return;
          }

          const targetUser = await User.findByPk(targetUserId);
          if (!targetUser) {
            await bot.sendMessage(userId, await getText(userId, 'creatorDiscountUserNotFound'));
            return;
          }

          await setUserState(userId, { action: 'grant_creator_discount', step: 'percent', targetUserId });
          await bot.sendMessage(userId, await getText(userId, 'enterCreatorDiscountPercent'));
          return;
        }

        if (state.step === 'percent') {
          const percent = parseInt(text, 10);
          if (!Number.isInteger(percent) || percent < 0 || percent > 100) {
            await bot.sendMessage(userId, await getText(userId, 'enterCreatorDiscountPercent'));
            return;
          }

          const targetUser = await User.findByPk(state.targetUserId);
          if (!targetUser) {
            await bot.sendMessage(userId, await getText(userId, 'creatorDiscountUserNotFound'));
            await clearUserState(userId);
            await showReferralSettingsAdmin(userId);
            return;
          }

          targetUser.creatorDiscountPercent = percent;
          await targetUser.save();
          const requiredPoints = await getEffectiveRedeemPointsForUser(targetUser.id);

          await bot.sendMessage(
            userId,
            await getText(userId, 'creatorDiscountUpdated', {
              userId: targetUser.id,
              percent,
              requiredPoints
            })
          );

          try {
            await bot.sendMessage(
              targetUser.id,
              await getText(targetUser.id, 'creatorDiscountGrantedNotification', {
                percent,
                requiredPoints
              })
            );
          } catch (notifyErr) {
            console.error('Creator discount notify error:', notifyErr.message);
          }

          await clearUserState(userId);
          await showReferralSettingsAdmin(userId);
          return;
        }
      }

      if (state.action === 'add_redeem_service') {
        if (state.step === 'nameEn') {
          await setUserState(userId, { ...state, nameEn: text, step: 'nameAr' });
          await bot.sendMessage(userId, await getText(userId, 'redeemServiceNameAr'));
          return;
        }
        if (state.step === 'nameAr') {
          await setUserState(userId, { ...state, nameAr: text, step: 'merchantDictId' });
          await bot.sendMessage(userId, await getText(userId, 'redeemServiceMerchantId'));
          return;
        }
        if (state.step === 'merchantDictId') {
          await setUserState(userId, { ...state, merchantDictId: text, step: 'platformId' });
          await bot.sendMessage(userId, await getText(userId, 'redeemServicePlatformId'));
          return;
        }
        if (state.step === 'platformId') {
          await RedeemService.create({
            nameEn: state.nameEn,
            nameAr: state.nameAr,
            merchantDictId: state.merchantDictId,
            platformId: text || '1'
          });
          await bot.sendMessage(userId, await getText(userId, 'redeemServiceAdded'));
          await clearUserState(userId);
          await showRedeemServicesAdmin(userId);
          return;
        }
      }

      if (state.action === 'add_discount_code') {
        if (state.step === 'code') {
          await setUserState(userId, { ...state, code: text, step: 'percent' });
          await bot.sendMessage(userId, await getText(userId, 'enterDiscountPercent'));
          return;
        }
        if (state.step === 'percent') {
          const percent = parseInt(text, 10);
          if (Number.isNaN(percent) || percent < 0 || percent > 100) {
            await bot.sendMessage(userId, 'Invalid percentage (0-100)');
            return;
          }
          await setUserState(userId, { ...state, percent, step: 'validUntil' });
          await bot.sendMessage(userId, await getText(userId, 'enterDiscountValidUntil'));
          return;
        }
        if (state.step === 'validUntil') {
          let validUntil = null;
          if (text !== '/skip') {
            const date = new Date(text);
            if (Number.isNaN(date.getTime())) {
              await bot.sendMessage(userId, 'Invalid date format. Use YYYY-MM-DD or /skip.');
              return;
            }
            validUntil = date;
          }
          await setUserState(userId, { ...state, validUntil, step: 'maxUses' });
          await bot.sendMessage(userId, await getText(userId, 'enterDiscountMaxUses'));
          return;
        }
        if (state.step === 'maxUses') {
          const maxUses = parseInt(text, 10);
          if (Number.isNaN(maxUses) || maxUses < 1) {
            await bot.sendMessage(userId, 'Invalid max uses (minimum 1)');
            return;
          }
          await DiscountCode.create({
            code: state.code,
            discountPercent: state.percent,
            validUntil: state.validUntil,
            maxUses,
            usedCount: 0,
            createdBy: userId
          });
          await bot.sendMessage(userId, await getText(userId, 'discountCodeAdded'));
          await clearUserState(userId);
          await showDiscountCodesAdmin(userId);
          return;
        }
      }

      if (state.action === 'set_iqd_rate') {
        const rate = parseFloat(text);
        if (Number.isNaN(rate) || rate <= 0) {
          await bot.sendMessage(userId, 'Invalid rate');
          return;
        }
        await updateDepositConfig('IQD', 'rate', rate);
        await bot.sendMessage(userId, await getText(userId, 'rateSet'));
        await clearUserState(userId);
        await showDepositSettingsAdmin(userId);
        return;
      }

      if (state.action === 'edit_currency_name') {
        const field = state.langCode === 'ar' ? 'displayNameAr' : 'displayNameEn';
        await updateDepositConfig(state.currency, field, text);
        await bot.sendMessage(userId, await getText(userId, 'currencyNameUpdated'));
        await clearUserState(userId);
        await showDepositSettingsAdmin(userId);
        return;
      }

      if (state.action === 'edit_deposit_template') {
        const field = state.langCode === 'ar' ? 'templateAr' : 'templateEn';
        await updateDepositConfig(state.currency, field, text);
        await bot.sendMessage(userId, await getText(userId, 'instructionsSet'));
        await clearUserState(userId);
        await showDepositSettingsAdmin(userId);
        return;
      }

      if (state.action === 'add_deposit_method') {
        if (state.step === 'nameAr') {
          await setUserState(userId, { ...state, nameAr: text, step: 'nameEn' });
          await bot.sendMessage(userId, await getText(userId, 'enterMethodNameEn'));
          return;
        }
        if (state.step === 'nameEn') {
          await setUserState(userId, { ...state, nameEn: text, step: 'value' });
          await bot.sendMessage(userId, await getText(userId, 'enterMethodValue'));
          return;
        }
        if (state.step === 'value') {
          await addDepositMethod(state.currency, { nameAr: state.nameAr, nameEn: state.nameEn, value: text });
          await bot.sendMessage(userId, await getText(userId, 'methodAdded'));
          await clearUserState(userId);
          await showDepositMethodsAdmin(userId, state.currency);
          return;
        }
      }

      if (state.action === 'edit_deposit_instructions') {
        await updateDepositConfig(state.currency, 'instructions', text);
        await bot.sendMessage(userId, await getText(userId, 'instructionsSet'));
        await clearUserState(userId);
        await showDepositSettingsAdmin(userId);
        return;
      }
    }

    if (state?.action === 'support') {
      const supportText = text || '';
      const photoFileId = photo ? photo[photo.length - 1].file_id : null;
      const notifText = await getText(ADMIN_ID, 'supportNotification', {
        userId,
        username: msg.from?.username ? `@${msg.from.username}` : 'لا يوجد',
        name: [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(' ').trim() || 'لا يوجد',
        message: supportText || 'No message'
      });
      if (photoFileId) {
        await bot.sendPhoto(ADMIN_ID, photoFileId, { caption: notifText });
      } else {
        await bot.sendMessage(ADMIN_ID, notifText);
      }
      const replyButton = { inline_keyboard: [[{ text: await getText(ADMIN_ID, 'replyToSupport'), callback_data: `support_reply_${userId}` }]] };
      await bot.sendMessage(ADMIN_ID, await getText(ADMIN_ID, 'replyToSupport'), { reply_markup: replyButton });
      await bot.sendMessage(userId, await getText(userId, 'supportMessageSent'));
      await clearUserState(userId);
      return;
    }

    if (state?.action === 'discount') {
      const discountCode = String(text || '').trim();
      const discount = await DiscountCode.findOne({ where: { code: discountCode } });
      if (discount && (!discount.validUntil || discount.validUntil > new Date()) && discount.usedCount < discount.maxUses) {
        await bot.sendMessage(userId, await getText(userId, 'discountApplied', { percent: discount.discountPercent }));
        await setUserState(userId, { action: 'discount_ready', discountCode });
      } else {
        await bot.sendMessage(userId, await getText(userId, 'discountInvalid'));
        await clearUserState(userId);
      }
      await sendMainMenu(userId);
      return;
    }

    if (state?.action === 'buy') {
      const qty = parseInt(text, 10);
      if (Number.isNaN(qty) || qty <= 0) {
        await bot.sendMessage(userId, '❌ Invalid quantity.');
        return;
      }
      const merchant = await Merchant.findByPk(state.merchantId);
      if (!merchant) {
        await bot.sendMessage(userId, 'Merchant not found');
        return;
      }
      const available = await Code.count({ where: { merchantId: merchant.id, isUsed: false } });
      if (qty > available) {
        await bot.sendMessage(userId, `${await getText(userId, 'noCodes')} Available: ${available}`);
        return;
      }
      const result = await processPurchase(userId, merchant.id, qty, state.discountCode || null);
      if (result.success) {
        let msgText = await getText(userId, 'success');
        if (result.discountApplied) msgText += `\n🎟️ Discount applied: ${result.discountApplied}%`;
        msgText += `\n\n${formatCodesForHtml(result.codes)}`;
        {
        const deliveryPrefix = await getCodeDeliveryPrefixHtml(userId);
        await bot.sendMessage(userId, `${deliveryPrefix}${msgText}`, { parse_mode: 'HTML' });
      }

        const userObj = await User.findByPk(userId);
        if (userObj.referredBy) {
          const referralPercent = parseFloat(process.env.REFERRAL_PERCENT || '10');
          const rewardAmount = Number(result.totalCost || (merchant.price * qty)) * referralPercent / 100;
          const referrer = await User.findByPk(userObj.referredBy);
          if (referrer) {
            await BalanceTransaction.create({ userId: referrer.id, amount: rewardAmount, type: 'referral', status: 'completed' });
            await User.update({ balance: parseFloat(referrer.balance) + rewardAmount }, { where: { id: referrer.id } });
            await bot.sendMessage(referrer.id, `🎉 Referral reward added: ${rewardAmount.toFixed(2)} USD`);
          }
        }
      } else if (result.reason === 'Insufficient balance') {
        await bot.sendMessage(
          userId,
          await getText(userId, 'insufficientBalance', {
            balance: Number(result.balance || 0).toFixed(2),
            price: Number(result.price || merchant.price || 0).toFixed(2),
            needed: Number(result.totalCost || 0).toFixed(2)
          }),
          {
            reply_markup: {
              inline_keyboard: [[{ text: await getText(userId, 'depositNow'), callback_data: 'deposit' }]]
            }
          }
        );
      } else {
        await bot.sendMessage(userId, `${await getText(userId, 'error')}: ${result.reason}`);
      }
      await clearUserState(userId);
      await sendMainMenu(userId);
      return;
    }

    if (state?.action === 'deposit_amount') {
      const amount = parseFloat(text);
      if (Number.isNaN(amount) || amount <= 0) {
        await bot.sendMessage(userId, '❌ Invalid amount');
        return;
      }
      await showPaymentMethodsForDeposit(userId, amount, state.currency);
      return;
    }

    if (state?.action === 'deposit_awaiting_proof') {
      const imageFileId = photo ? photo[photo.length - 1].file_id : null;
      const caption = String(msg.caption || text || '').trim();
      if (!imageFileId) return;
      await requestDeposit(userId, state.amount, state.currency, caption, imageFileId, msg.from || null);
      await bot.sendMessage(userId, await getText(userId, 'depositProofReceived'));
      await clearUserState(userId);
      await sendMainMenu(userId);
      return;
    }

    if (state?.action === 'redeem_via_service') {
      const service = await RedeemService.findByPk(state.serviceId);
      if (!service) {
        await bot.sendMessage(userId, 'Service not found');
        await clearUserState(userId);
        await sendMainMenu(userId);
        return;
      }
      const waitingMsg = await bot.sendMessage(userId, await getText(userId, 'processing'));
      const result = await redeemCard(String(text || '').trim(), service.merchantDictId, service.platformId);
      await bot.deleteMessage(userId, waitingMsg.message_id).catch(() => {});
      if (result.success) {
        await bot.sendMessage(userId, await getText(userId, 'redeemSuccess', { details: formatCardDetails(result.data) }));
      } else {
        await bot.sendMessage(userId, await getText(userId, 'redeemFailed', { reason: result.reason }));
      }
      await clearUserState(userId);
      await sendMainMenu(userId);
      return;
    }

    if (state?.action === 'redeem_smart') {
      const waitingMsg = await bot.sendMessage(userId, await getText(userId, 'processing'));
      const result = await redeemCardSmart(String(text || '').trim());
      await bot.deleteMessage(userId, waitingMsg.message_id).catch(() => {});
      if (result.success) {
        const serviceName = result.service ? `${result.service.nameEn} / ${result.service.nameAr}` : 'Auto';
        await bot.sendMessage(userId, await getText(userId, 'redeemSuccess', {
          details: `${formatCardDetails(result.data)}\n\n🏪 Selected Service: ${serviceName}`
        }));
      } else {
        await bot.sendMessage(userId, await getText(userId, 'redeemFailed', { reason: result.reason }));
      }
      await clearUserState(userId);
      await sendMainMenu(userId);
      return;
    }

    if (state?.action === 'chatgpt_free_email') {
      const email = String(text || '').trim();
      if (!email.includes('@') || !email.includes('.')) {
        await bot.sendMessage(userId, '❌ Invalid email format. Please send a valid email.');
        return;
      }
      const result = await getChatGPTCode(email);
      if (result.success) {
        if (!state.fromPoints) {
          await User.update({ freeChatgptReceived: true }, { where: { id: userId } });
        }
        await clearUserState(userId);
        await bot.sendMessage(userId, await getText(userId, 'freeCodeSuccess', { code: formatCodesForHtml(result.codes || [result.code]) }), { parse_mode: 'HTML' });
      } else {
        await bot.sendMessage(userId, `${await getText(userId, 'error')}: ${result.reason}`);
        await clearUserState(userId);
      }
      await sendMainMenu(userId);
      return;
    }

    if (state?.action === 'redeem_points_amount') {
      const requiredPoints = await getEffectiveRedeemPointsForUser(userId);
      const requestedCodes = parseInt(String(text || '').trim(), 10);

      if (Number.isNaN(requestedCodes) || requestedCodes <= 0) {
        await bot.sendMessage(userId, await getText(userId, 'redeemPointsInvalidAmount', { requiredPoints }));
        return;
      }

      const freshUser = await User.findByPk(userId);
      const neededPoints = requestedCodes * requiredPoints;
      if (Number(freshUser.referralPoints || 0) < neededPoints) {
        await bot.sendMessage(userId, await getText(userId, 'notEnoughPoints', { points: freshUser.referralPoints, requiredPoints }));
        await clearUserState(userId);
        return;
      }

      const quantity = requestedCodes;
      const waitingMsg = await bot.sendMessage(userId, await getText(userId, 'processing'));
      const result = await processAutoChatGptCode(userId, { isFree: true, fromPoints: true, quantity });
      await bot.deleteMessage(userId, waitingMsg.message_id).catch(() => {});

      if (result.success) {
        const usedPoints = (parseInt(result.quantity, 10) || 0) * requiredPoints;
        freshUser.referralPoints = Math.max(0, Number(freshUser.referralPoints || 0) - usedPoints);
        await freshUser.save();
        {
        const deliveryPrefix = await getCodeDeliveryPrefixHtml(userId);
        await bot.sendMessage(userId, `${deliveryPrefix}${await getText(userId, 'pointsRedeemed', { code: formatCodesForHtml(result.codes) })}`, { parse_mode: 'HTML' });
      }
      } else {
        await bot.sendMessage(userId, `${await getText(userId, 'error')}: ${result.reason}`);
      }

      await clearUserState(userId);
      await sendMainMenu(userId);
      return;
    }

    if (state?.action === 'chatgpt_buy_quantity') {
      const qty = parseInt(text, 10);
      if (Number.isNaN(qty) || qty <= 0) {
        await bot.sendMessage(userId, await getText(userId, 'invalidQuantity'));
        return;
      }

      const waitingMsg = await bot.sendMessage(userId, await getText(userId, 'processing'));
      let result = await processAutoChatGptCode(userId, { isFree: false, quantity: qty });
      await bot.deleteMessage(userId, waitingMsg.message_id).catch(() => {});

      if (result.success) {
        let successText = await getText(userId, 'purchaseSuccess', { code: formatCodesForHtml(result.codes) });
        if (result.partial) {
          successText += `

⚠️ Requested: ${result.requestedQuantity} | Delivered: ${result.quantity}`;
        }
        {
        const deliveryPrefix = await getCodeDeliveryPrefixHtml(userId);
        await bot.sendMessage(userId, `${deliveryPrefix}${successText}`, { parse_mode: 'HTML' });
      }
      } else if (result.reason === 'INSUFFICIENT_BALANCE') {
        const freshUser = await User.findByPk(userId);
        const requiredPoints = await getEffectiveRedeemPointsForUser(userId);
        const neededPoints = qty * requiredPoints;

        if (Number(freshUser?.referralPoints || 0) >= neededPoints) {
          const waitingPointsMsg = await bot.sendMessage(userId, await getText(userId, 'processing'));
          result = await processAutoChatGptCode(userId, { isFree: true, fromPoints: true, quantity: qty });
          await bot.deleteMessage(userId, waitingPointsMsg.message_id).catch(() => {});

          if (result.success) {
            const usedPoints = (parseInt(result.quantity, 10) || 0) * requiredPoints;
            freshUser.referralPoints = Math.max(0, Number(freshUser.referralPoints || 0) - usedPoints);
            await freshUser.save();

            let successText = await getText(userId, 'pointsRedeemed', { code: formatCodesForHtml(result.codes) });
            if (result.partial) {
              successText += `

⚠️ Requested: ${qty} | Delivered: ${result.quantity}`;
            }
            const deliveryPrefix = await getCodeDeliveryPrefixHtml(userId);
            await bot.sendMessage(userId, `${deliveryPrefix}${successText}`, { parse_mode: 'HTML' });
          } else {
            await bot.sendMessage(userId, `${await getText(userId, 'error')}: ${result.reason}`);
          }
        } else {
          await bot.sendMessage(
            userId,
            await getText(userId, 'insufficientBalance', {
              balance: result.balance,
              price: result.price,
              needed: result.totalCost
            }),
            {
              reply_markup: {
                inline_keyboard: [[{ text: await getText(userId, 'depositNow'), callback_data: 'deposit' }]]
              }
            }
          );
        }
      } else {
        await bot.sendMessage(userId, `${await getText(userId, 'error')}: ${result.reason}`);
      }
      await clearUserState(userId);
      await sendMainMenu(userId);
      return;
    }



  } catch (err) {
    console.error('Message handler error:', err);
    await bot.sendMessage(userId, 'An error occurred. Please try again later.').catch(() => {});
  }
});

app.post('/api/code', async (req, res) => {
  try {
    const { token, card_key, merchant_dict_id, platform_id } = req.body;
    const botService = await BotService.findOne({ where: { token, isActive: true } });
    if (!botService || !Array.isArray(botService.allowedActions) || !botService.allowedActions.includes('code')) {
      return res.status(403).json({ error: 'Bot not authorized for /code' });
    }
    if (!card_key) {
      return res.status(400).json({ error: 'Missing card_key' });
    }

    let result;
    if (merchant_dict_id) result = await redeemCard(card_key, merchant_dict_id, platform_id || '1');
    else result = await redeemCardSmart(card_key);

    if (result.success) {
      return res.json({
        success: true,
        data: result.data,
        service: result.service ? {
          id: result.service.id,
          nameEn: result.service.nameEn,
          nameAr: result.service.nameAr,
          merchantDictId: result.service.merchantDictId
        } : null
      });
    }

    return res.status(400).json({ success: false, error: result.reason });
  } catch (err) {
    console.error('API error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

setInterval(async () => {
  try {
    const now = new Date();
    const updated = await Code.update({ isUsed: true }, { where: { expiresAt: { [Op.lt]: now }, isUsed: false } });
    if (updated[0] > 0) console.log(`✅ Expired codes marked as used: ${updated[0]} codes`);
  } catch (err) {
    console.error('Error cleaning expired codes:', err);
  }
}, 24 * 60 * 60 * 1000);

setInterval(async () => {
  try {
    await refreshChatGPTCookies(true);
    console.log('✅ ChatGPT cookies refreshed');
  } catch (err) {
    console.error('Cookie refresh error:', err.message);
  }
}, 5 * 60 * 1000);

sequelize.sync({ alter: true }).then(async () => {
  console.log('✅ Database synced');
  await getDepositConfig('USD');
  await getDepositConfig('IQD');
  await getChannelConfig();
  await refreshChatGPTCookies(false);

  await getOrCreateChatGptMerchant();

  const PORT = process.env.PORT || 3000;
  app.get('/', (req, res) => res.send('Bot is running'));
  app.listen(PORT, () => console.log(`🚀 Server started on port ${PORT}`));
}).catch(err => {
  console.error('Database error:', err);
  process.exit(1);
});
