import { z } from 'zod';

const objectIdSchema = z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid ObjectId');
const optionalObjectIdSchema = z.union([objectIdSchema, z.literal('')]).optional();
const optionalDateStringSchema = z.string().optional();
const booleanStringSchema = z.enum(['true', 'false']).optional();

// ── Auth ──────────────────────────────────────────────────────────────────────

export const loginSchema = z.object({
  username: z.string().min(1, 'Username is required'),
  password: z.string().min(1, 'Password is required'),
});

// ── Users ─────────────────────────────────────────────────────────────────────

const USER_ROLES = [
  'productadmin',
  'listingadmin',
  'lister',
  'advancelister',
  'compatibilityadmin',
  'compatibilityeditor',
  'seller',
  'fulfillmentadmin',
  'hradmin',
  'hr',
  'operationhead',
  'trainee',
  'hoc',
  'compliancemanager',
];

export const createUserSchema = z.object({
  username: z.string().min(1, 'Username is required'),
  password: z.string().min(1, 'Password is required'),
  newUserRole: z.enum(USER_ROLES, { errorMap: () => ({ message: 'Invalid role' }) }),
  // email is optional — if provided it must be a valid address or an empty string
  email: z.union([z.string().email('Invalid email format'), z.literal('')]).optional(),
  department: z.string().optional(),
});

// ── Leaves ────────────────────────────────────────────────────────────────────

export const createLeaveSchema = z.object({
  startDate: z.string().min(1, 'Start date is required'),
  endDate: z.string().min(1, 'End date is required'),
  reason: z.string().trim().min(1, 'Reason is required'),
});

export const updateLeaveStatusSchema = z.object({
  status: z.enum(['approved', 'rejected'], {
    errorMap: () => ({ message: 'Status must be "approved" or "rejected"' }),
  }),
  rejectionReason: z.string().optional(),
});

// ── Config masters ────────────────────────────────────────────────────────────

export const createCategorySchema = z.object({
  name: z.string().min(1, 'Name is required'),
});

export const createPlatformSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  type: z.string().min(1, 'Type is required'),
});

export const createSubcategorySchema = z.object({
  name: z.string().min(1, 'Name is required'),
  categoryId: z.string().min(1, 'Category is required'),
});

export const createRangeSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  categoryId: z.string().optional(),
});

export const createStoreSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  platformId: z.string().min(1, 'Platform is required'),
});

// ── Financial entities ────────────────────────────────────────────────────────

export const createCreditCardSchema = z.object({
  name: z.string().trim().min(1, 'Card name is required'),
});

export const createBankAccountSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  accountNumber: z.string().optional(),
  ifscCode: z.string().optional(),
});

export const createPaymentAccountSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  bankAccount: z.string().min(1, 'Bank account is required'),
});

// ── Financial transactions ────────────────────────────────────────────────────

export const createSalarySchema = z.object({
  year: z.number({ invalid_type_error: 'Year must be a number' })
    .int()
    .min(2000, 'Year must be 2000 or later')
    .max(2099, 'Year must be 2099 or earlier'),
  name: z.string().min(1, 'Name is required'),
  designation: z.string().optional(),
});

export const createTransactionSchema = z.object({
  date: z.string().min(1, 'Date is required'),
  bankAccount: z.string().min(1, 'Bank account is required'),
  transactionType: z.enum(['Debit', 'Credit'], {
    errorMap: () => ({ message: 'Transaction type must be "Debit" or "Credit"' }),
  }),
  amount: z.coerce.number({ invalid_type_error: 'Amount must be a number' }),
  remark: z.string().optional(),
  creditCardName: z.string().optional(),
});

export const updateTransactionSchema = createTransactionSchema.partial();

export const createExtraExpenseSchema = z.object({
  date: z.string().min(1, 'Date is required'),
  name: z.string().min(1, 'Name is required'),
  amount: z.coerce.number({ invalid_type_error: 'Amount must be a number' }),
  paidBy: z.string().min(1, 'paidBy is required'),
});

// ── Tasks ─────────────────────────────────────────────────────────────────────

export const createTaskSchema = z.object({
  marketplace: z.string().min(1, 'Marketplace is required'),
  date: z.string().optional(),
  productTitle: z.string().optional(),
  supplierLink: z.string().optional(),
  link: z.string().optional(),            // legacy alias
  sourcePrice: z.number().optional(),
  sellingPrice: z.number().optional(),
  quantity: z.number().int().optional(),
  sourcePlatformId: z.string().optional(),
  categoryId: z.string().optional(),
  subcategoryId: z.string().optional(),
  rangeId: z.string().optional(),
  listingPlatformId: z.string().optional(),
  storeId: z.string().optional(),
  assignedListerId: z.string().optional(),
});

// ── Assignments ───────────────────────────────────────────────────────────────

export const createAssignmentSchema = z.object({
  taskId: z.string().min(1, 'Task is required'),
  listerId: z.string().min(1, 'Lister is required'),
  quantity: z.number({ invalid_type_error: 'Quantity must be a number' }).int().min(1, 'Quantity must be at least 1'),
  listingPlatformId: z.string().min(1, 'Listing platform is required'),
  storeId: z.string().min(1, 'Store is required'),
  notes: z.string().optional(),
  scheduledDate: z.string().optional(),
});

// ── Meetings ─────────────────────────────────────────────────────────────────

const meetingActionItemSchema = z.object({
  text: z.string().trim().min(1, 'Action item text is required'),
  assigneeId: z.string().optional(),
  dueDate: z.string().optional(),
  status: z.enum(['pending', 'in-progress', 'done']).optional(),
});

export const createMeetingSchema = z.object({
  title: z.string().trim().min(1, 'Title is required'),
  scheduledFor: z.string().min(1, 'Meeting date is required'),
  organizerId: z.string().min(1, 'Organizer is required'),
  attendeeIds: z.array(z.string().min(1)).min(1, 'At least one attendee is required'),
  status: z.enum(['planned', 'in-progress', 'completed', 'cancelled']).optional(),
  location: z.string().optional(),
  agenda: z.string().optional(),
  discussionSummary: z.string().optional(),
  decisions: z.string().optional(),
  futureScope: z.string().optional(),
  actionItems: z.array(meetingActionItemSchema).optional(),
});

export const updateMeetingSchema = createMeetingSchema.partial();

// ── Internal messages ─────────────────────────────────────────────────────────

export const sendMessageSchema = z.object({
  recipientId: z.string().min(1, 'Recipient is required'),
  body: z.string().min(1, 'Message body is required'),
  mediaUrls: z.array(z.string()).optional(),
});

// ── Ideas ─────────────────────────────────────────────────────────────────────

export const createIdeaSchema = z.object({
  title: z.string().min(1, 'Title is required'),
  description: z.string().min(1, 'Description is required'),
  createdBy: z.string().min(1, 'createdBy is required'),
  type: z.enum(['idea', 'bug', 'feature', 'improvement']).optional(),
  priority: z.enum(['low', 'medium', 'high']).optional(),
  completeByDate: z.string().optional(),
});

export const addIdeaCommentSchema = z.object({
  text: z.string().min(1, 'Comment text is required'),
  commentedBy: z.string().min(1, 'commentedBy is required'),
});

// ── Amazon accounts ───────────────────────────────────────────────────────────

export const createAmazonAccountSchema = z.object({
  name: z.string().min(1, 'Account name is required'),
  addressLine1: z.string().optional(),
  addressLine2: z.string().optional(),
  city: z.string().optional(),
  state: z.string().optional(),
  postalCode: z.string().optional(),
  country: z.string().optional(),
  phoneNumber: z.string().optional(),
  notes: z.string().optional(),
});

// ── Chat templates ────────────────────────────────────────────────────────────

export const createChatTemplateSchema = z.object({
  category: z.string().min(1, 'Category is required'),
  label: z.string().min(1, 'Label is required'),
  text: z.string().min(1, 'Text is required'),
});

// ── Column presets ────────────────────────────────────────────────────────────

export const createColumnPresetSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  columns: z.array(z.any()).min(1, 'Columns are required'),
  page: z.string().optional(),
});

// ── Custom columns ────────────────────────────────────────────────────────────

export const createCustomColumnSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  prompt: z.string().min(1, 'Prompt is required'),
  dataType: z.string().optional(),
  description: z.string().optional(),
});

// ── Remark templates ──────────────────────────────────────────────────────────

const remarkTemplateItemSchema = z.object({
  id: z.string().optional(),
  name: z.string().min(1, 'Template name is required'),
  text: z.string().min(1, 'Template text is required'),
});

export const updateRemarkTemplatesSchema = z.object({
  templates: z.array(remarkTemplateItemSchema).min(1, 'templates must be a non-empty array'),
});

// ── Credit card names ─────────────────────────────────────────────────────────

export const creditCardNameSchema = z.object({
  name: z.string().trim().min(1, 'Card name is required'),
});

// ── Resolution options ────────────────────────────────────────────────────────

export const resolutionOptionSchema = z.object({
  name: z.string().trim().min(1, 'Resolution option name is required'),
});

// ── Quantity update exclusions ────────────────────────────────────────────────

// Accepts either a single ItemID, an array of them, or one pasted blob of IDs
// separated by newlines / commas / spaces. Splitting happens in the route.
export const quantityUpdateExclusionSchema = z.object({
  itemIds: z.union([
    z.string().trim().min(1, 'At least one ItemID is required'),
    z.array(z.string()).min(1, 'At least one ItemID is required'),
  ]),
  note: z.string().trim().max(500, 'Note is too long').optional(),
});

// ── Seller upload limits ──────────────────────────────────────────────────────

const UPLOAD_LIMIT_COUNTRIES = ['US', 'UK', 'AU', 'Canada'];

export const sellerUploadLimitSchema = z.object({
  sellerId: z.string().min(1, 'sellerId is required'),
  country: z.enum(UPLOAD_LIMIT_COUNTRIES, {
    errorMap: () => ({ message: 'country must be one of: US, UK, AU, Canada' }),
  }),
  limit: z.coerce.number().int().min(1, 'limit must be a positive integer'),
});

export const sellerUploadLimitCheckQuerySchema = z.object({
  sellerId: z.string().min(1, 'sellerId is required'),
  country: z.enum(UPLOAD_LIMIT_COUNTRIES, {
    errorMap: () => ({ message: 'country must be one of: US, UK, AU, Canada' }),
  }),
});

// ── End listing logs ─────────────────────────────────────────────────────────

export const endListingStatsQuerySchema = z.object({
  sellerId: optionalObjectIdSchema,
  startDate: optionalDateStringSchema,
  endDate: optionalDateStringSchema,
  country: z.string().trim().min(1).optional(),
});

// ── Price change logs ────────────────────────────────────────────────────────

export const priceChangeLogsQuerySchema = z.object({
  legacyItemId: z.string().optional(),
  orderId: z.string().optional(),
  userId: optionalObjectIdSchema,
  sellerId: optionalObjectIdSchema,
  startDate: optionalDateStringSchema,
  endDate: optionalDateStringSchema,
  successOnly: booleanStringSchema,
  failedOnly: booleanStringSchema,
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).optional(),
});

// ── Micro orders ─────────────────────────────────────────────────────────────

export const microOrdersQuerySchema = z.object({
  seller: optionalObjectIdSchema,
  dateMode: z.enum(['none', 'single', 'range']).optional(),
  date: optionalDateStringSchema,
  dateFrom: optionalDateStringSchema,
  dateTo: optionalDateStringSchema,
  excludeClient: booleanStringSchema,
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

// ── Item category map ────────────────────────────────────────────────────────

export const itemNumberParamsSchema = z.object({
  itemNumber: z.string().trim().min(1, 'itemNumber is required'),
});

export const itemCategoryLookupSchema = z.object({
  itemNumbers: z.array(z.string().trim().min(1)).min(1, 'itemNumbers array is required'),
});

export const updateItemCategoryMapSchema = z.object({
  categoryId: objectIdSchema,
  rangeId: optionalObjectIdSchema.nullable(),
  productId: optionalObjectIdSchema.nullable(),
});

// ── User seller assignments ──────────────────────────────────────────────────

export const idParamsSchema = z.object({
  id: objectIdSchema,
});

// ── Feature permissions ──────────────────────────────────────────────────────

export const featurePermissionParamsSchema = z.object({
  featureId: z.string().min(1, 'Feature ID is required'),
});

export const updateFeaturePermissionSchema = z.object({
  allowedUserIds: z.array(objectIdSchema),
});

export const createUserSellerAssignmentSchema = z.object({
  userId: objectIdSchema,
  sellerId: objectIdSchema,
  dailyTarget: z.coerce.number().optional(),
});

export const updateUserSellerTargetSchema = z.object({
  dailyTarget: z.coerce.number({ invalid_type_error: 'Valid daily target is required' }),
});

export const updatePerformanceRemarksSchema = z.object({
  remarks: z.enum(['Good', 'Average', 'Need for improvement', ''], {
    errorMap: () => ({ message: 'Invalid remark value' }),
  }),
});

// ── ASIN list categories ──────────────────────────────────────────────────────

// Keyword sets stand in for Amazon browse nodes in the ASIN sourcing flow —
// the search API has no category parameter. Normalization (trim/dedupe/cap)
// happens in the model setter; this only guards the shape.
const searchQueriesField = z.array(z.string()).max(25, 'At most 25 keywords').optional();

export const createAsinListCategorySchema = z.object({
  name: z.string().trim().min(1, 'Category name is required'),
  searchQueries: searchQueriesField,
});

export const updateAsinListCategorySchema = z.object({
  name: z.string().trim().min(1, 'Category name is required').optional(),
  searchQueries: searchQueriesField,
});

// ── ASIN list ranges ──────────────────────────────────────────────────────────

export const createAsinListRangeSchema = z.object({
  name: z.string().trim().min(1, 'Range name is required'),
  categoryId: z.string().min(1, 'categoryId is required'),
  searchQueries: searchQueriesField,
});

export const renameAsinListRangeSchema = z.object({
  name: z.string().trim().min(1, 'Range name is required').optional(),
  searchQueries: searchQueriesField,
});

// ── ASIN list products ────────────────────────────────────────────────────────

export const createAsinListProductSchema = z.object({
  name: z.string().trim().min(1, 'Product name is required'),
  rangeId: z.string().min(1, 'rangeId is required'),
  categoryId: z.string().min(1, 'categoryId is required'),
  searchQueries: searchQueriesField,
});

export const renameAsinListProductSchema = z.object({
  name: z.string().trim().min(1, 'Product name is required').optional(),
  searchQueries: searchQueriesField,
});

// ── ASIN sourcing runs ───────────────────────────────────────────────────────

export const recordDiscardedAsinsSchema = z.object({
  asins: z.array(z.string()).min(1, 'asins must be a non-empty array'),
});

export const recordContinuedAsinsSchema = z.object({
  asins: z.array(z.string()).min(1, 'asins must be a non-empty array'),
  // Counts only, keyed by reason — see AsinSourcingRun.precheckStats.
  dropped: z.record(z.string(), z.number()).optional(),
  served: z.number().optional(),
});

export const moveAsinsSchema = z.object({
  asinIds: z.array(z.string()).min(1, 'asinIds must be a non-empty array'),
  productId: z.string().min(1, 'productId is required'),
});

export const copyProductsToRangeSchema = z.object({
  productIds: z.array(z.string()).min(1, 'productIds must be a non-empty array'),
  targetRangeId: z.string().optional(),
  targetRangeIds: z.array(z.string()).optional(),
});

// ── ASIN directory ────────────────────────────────────────────────────────────

const ASIN_REGIONS = ['US', 'UK', 'AU', 'CA', 'DE', 'FR', 'IT', 'ES', 'MX', 'IN'];

export const bulkAddAsinsSchema = z.object({
  asins: z.array(z.string()).min(1, 'asins must be a non-empty array'),
  region: z.string().optional().default('US'),
});

export const csvImportAsinsSchema = z.object({
  csvData: z.string().min(1, 'csvData is required'),
  region: z.string().optional().default('US'),
});

export const updateAsinSchema = z.object({
  price: z.coerce.number().optional(),
  description: z.string().optional(),
});

export const bulkDeleteAsinsSchema = z.object({
  ids: z.array(z.string()).min(1, 'ids must be a non-empty array'),
});

// ── Attendance ────────────────────────────────────────────────────────────────

export const editAttendanceHoursSchema = z.object({
  totalWorkTime: z.coerce
    .number()
    .min(0, 'totalWorkTime must be a non-negative number (milliseconds)'),
});

// ── Employee profiles ─────────────────────────────────────────────────────────

// All fields optional — mirrors the pickProfile() whitelist already in the route.
// Zod ensures correct types before pickProfile() filters further.
const employeeProfileFields = {
  name: z.string().optional(),
  phoneNumber: z.string().optional(),
  dateOfBirth: z.string().optional(),
  bloodGroup: z.string().optional(),
  dateOfJoining: z.string().optional(),
  gender: z.string().optional(),
  address: z.string().optional(),
  email: z.union([z.string().email('Invalid email format'), z.literal('')]).optional(),
  bankAccountNumber: z.string().optional(),
  bankIFSC: z.string().optional(),
  bankName: z.string().optional(),
  aadharNumber: z.string().optional(),
  panNumber: z.string().optional(),
  profilePicUrl: z.string().optional(),
  aadharImageUrl: z.string().optional(),
  panImageUrl: z.string().optional(),
  myTaskList: z.any().optional(),
  primaryTask: z.string().optional(),
  secondaryTask: z.string().optional(),
};

export const updateMyProfileSchema = z.object(employeeProfileFields);

// Admin PUT also reads workingMode, workingHours, role, department from req.body
export const adminUpdateProfileSchema = z.object({
  ...employeeProfileFields,
  workingMode: z.string().optional(),
  workingHours: z.union([z.string(), z.number()]).optional(),
  role: z.string().optional(),
  department: z.string().optional(),
});

export const adminProfileFieldsSchema = z.object({
  workingMode: z.string().optional(),
  workingHours: z.union([z.string(), z.number()]).optional(),
});

// ── Listing stats ────────────────────────────────────────────────────────────

export const listingStatsDayWiseQuerySchema = z.object({
  startDate: optionalDateStringSchema,
  endDate: optionalDateStringSchema,
  sellerId: optionalObjectIdSchema,
});

export const listingStatsSummaryQuerySchema = z.object({
  startDate: optionalDateStringSchema,
  endDate: optionalDateStringSchema,
});

// ── Seller pricing config ────────────────────────────────────────────────────

export const sellerPricingConfigQuerySchema = z.object({
  sellerId: objectIdSchema,
  templateId: objectIdSchema,
});

export const sellerPricingConfigBodySchema = z.object({
  sellerId: objectIdSchema,
  templateId: objectIdSchema,
  pricingConfig: z.record(z.string(), z.any()),
});

// ── Exchange rates ────────────────────────────────────────────────────────────

export const exchangeRateCurrentQuerySchema = z.object({
  marketplace: z.string().trim().optional(),
});

export const exchangeRateHistoryQuerySchema = z.object({
  marketplace: z.string().trim().optional(),
  limit: z.coerce.number().int().positive().max(500).optional(),
});

export const exchangeRateForDateQuerySchema = z.object({
  date: z.string().trim().min(1, 'date is required'),
  marketplace: z.string().trim().optional(),
});

export const createExchangeRateSchema = z.object({
  rate: z.coerce.number({ invalid_type_error: 'rate must be a number' }).positive('rate must be a positive number'),
  effectiveDate: z.string().trim().min(1, 'effectiveDate is required'),
  marketplace: z.string().trim().optional(),
  notes: z.string().optional(),
  applicationMode: z.enum(['effective', 'specific-date'], {
    errorMap: () => ({ message: 'applicationMode must be either effective or specific-date' }),
  }).optional(),
  updateExistingOrders: z.boolean().optional(),
});

// ── Payoneer ──────────────────────────────────────────────────────────────────

export const payoneerListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
  startDate: optionalDateStringSchema,
  endDate: optionalDateStringSchema,
  store: optionalObjectIdSchema,
});

export const createPayoneerRecordSchema = z.object({
  bankAccount: objectIdSchema,
  paymentDate: z.string().trim().min(1, 'paymentDate is required'),
  amount: z.coerce.number({ invalid_type_error: 'amount must be a number' }).positive('amount must be a positive number'),
  exchangeRate: z.coerce.number({ invalid_type_error: 'exchangeRate must be a number' }).positive('exchangeRate must be a positive number'),
  store: objectIdSchema,
  periodStart: z.string().optional(),
  periodEnd: z.string().optional(),
  profit: z.union([z.literal(''), z.coerce.number()]).optional(),
});

export const updatePayoneerRecordSchema = createPayoneerRecordSchema.partial();

// ── User category targets ────────────────────────────────────────────────────

const USER_CATEGORY_TARGET_MARKETPLACES = ['US', 'UK', 'AU', 'Canada'];

export const userCategoryTargetsPerformanceQuerySchema = z.object({
  startDate: optionalDateStringSchema,
  endDate: optionalDateStringSchema,
  userId: optionalObjectIdSchema,
  sellerId: optionalObjectIdSchema,
  marketplace: z.string().trim().optional(),
  categoryId: optionalObjectIdSchema,
  rangeId: optionalObjectIdSchema,
});

export const createUserCategoryTargetSchema = z.object({
  userId: objectIdSchema,
  sellerId: objectIdSchema,
  marketplace: z.enum(USER_CATEGORY_TARGET_MARKETPLACES, {
    errorMap: () => ({ message: 'marketplace must be one of: US, UK, AU, Canada' }),
  }),
  categoryId: objectIdSchema,
  rangeId: optionalObjectIdSchema,
  dailyDesiredQuantity: z.coerce.number({
    invalid_type_error: 'Daily desired quantity must be a number greater than or equal to 0',
  }).min(0, 'Daily desired quantity must be a number greater than or equal to 0'),
});

// ── Discounts (eBay Sell Marketing) ──────────────────────────────────────────
// These schemas are intentionally permissive on *values* and strict on *types*.
//
// Rationale: the discounts handlers already filter unrecognised values rather
// than rejecting them (e.g. `if (status && VALID_STATUSES.includes(status))`),
// and `/detail` keeps its own required-field + eBay-URL checks. Turning those
// silent ignores into 400s would be a behaviour change, so the schemas only
// guarantee "this is a string, not an array/object" — which is what actually
// guards the handlers against crafted query params like `?status[$ne]=x`.
//
// NOTE: `validate()` strips keys that aren't declared here, so every query
// param a handler reads must be listed or it will arrive as `undefined`.

export const discountsListQuerySchema = z.object({
  // Required-ness stays in the handler so its 'Missing sellerId' message is kept;
  // this only rejects a malformed id (which today reaches Mongoose as a CastError).
  sellerId: optionalObjectIdSchema,
  status: z.string().trim().optional(),
  type: z.string().trim().optional(),
  q: z.string().trim().optional(),
  sort: z.string().trim().optional(),
});

export const discountsAllQuerySchema = z.object({
  status: z.string().trim().optional(),
  type: z.string().trim().optional(),
  // Comma-separated list (e.g. 'CODED_COUPON,MARKDOWN_SALE'); parsed by parseTypes()
  types: z.string().trim().optional(),
  q: z.string().trim().optional(),
  sort: z.string().trim().optional(),
});

export const discountsCachedQuerySchema = z.object({
  // Compared with === 'true'; any other value means "use cache"
  refresh: z.string().trim().optional(),
});

export const discountsEndingSoonQuerySchema = z.object({
  // parseInt'd and clamped to 1..30 by the handler, so non-numeric input is
  // already handled there (falls back to 3) — kept as a string for parity.
  days: z.string().trim().optional(),
  refresh: z.string().trim().optional(),
});

export const discountsDetailQuerySchema = z.object({
  // Both stay optional here: the handler returns a specific 400 for missing
  // fields and enforces the eBay Marketing API prefix on href (SSRF guard).
  sellerId: optionalObjectIdSchema,
  href: z.string().trim().optional(),
});
