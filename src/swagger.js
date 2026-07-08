/**
 * OpenAPI / Swagger specification for the Grow EMS API.
 *
 * Served at GET /api-docs
 *
 * Base definition (schemas, securitySchemes, shared tags) lives here.
 * Per-route documentation goes in @swagger JSDoc blocks inside each src/routes/*.js file.
 */
import swaggerJsdoc from 'swagger-jsdoc';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const swaggerDefinition = {
    openapi: '3.0.0',
    info: {
        title: 'Grow EMS API',
        version: '1.0.0',
        description:
            'Full REST API for the Grow Mentality EMS platform. ' +
            'Covers auth, leaves, sellers, eBay inbox, chat, orders, employee profiles, and more.',
        contact: { name: 'Grow Internal' }
    },
    servers: [
        { url: '/api', description: 'Current environment' }
    ],
    tags: [
        { name: 'Auth', description: 'Authentication — login and token management' },
        { name: 'Leaves', description: 'Employee leave requests and admin approval' },
        { name: 'Listing Stats', description: 'Listing analytics and day-wise counts' },
        { name: 'Sellers', description: 'Seller account management' },
        { name: 'eBay – Inbox', description: 'Inbox sync and thread listing' },
        { name: 'eBay – Messages', description: 'Per-thread message fetching and sending' },
        { name: 'eBay – Conversation Meta', description: 'Tags (About / Status / Picked Up By) saved per thread' },
        { name: 'eBay – Chat Agents', description: 'Agents listed in the "Picked Up By" dropdown' },
        { name: 'eBay – Item Images', description: 'Product thumbnail fetched from eBay and cached' },
        { name: 'Chat Templates', description: 'Reusable response templates grouped by category' },
        { name: 'Upload', description: 'File / image uploads attached to outgoing messages' },
        { name: 'Template Listings', description: 'CRUD, pagination, stats and analytics for per-template eBay listings' },
        { name: 'Template Listings – Bulk Ops', description: 'Bulk create, save, update, delete and ASIN-driven import/autofill' },
        { name: 'Template Listings – CSV', description: 'eBay CSV export, direct export, and download-batch history' },
        { name: 'Template Listings – Admin', description: 'Schedule management, SKU activation/deactivation, cache and API-usage admin' },
        { name: 'Platforms', description: 'Source and listing platform management' },
        { name: 'Stores', description: 'Stores linked to a platform' },
        { name: 'Column Presets', description: 'Saved column-visibility presets per page' },
        { name: 'Seller Pricing Config', description: 'Per-seller pricing config overrides for a template' },
        { name: 'Seller Upload Limits', description: 'Daily eBay feed upload caps per seller+country' },
        { name: 'CSV Storage', description: 'Stored CSV exports with download and scheduled-upload management' },
        { name: 'Item Category Map', description: 'Map eBay item numbers to category/range/product (CRP) and propagate to orders' },
        { name: 'User Sellers', description: 'User-seller assignments and daily performance tracking' },
        { name: 'Remark Templates', description: 'Buyer-message remark templates with bulk save and soft-delete' },
        { name: 'Resolution Options', description: 'Dispute resolution options (e.g. Replace, Reorder)' },
        { name: 'Credit Card Names', description: 'Lookup list of credit card names for expense tracking' },
        { name: 'AI', description: 'OpenAI-powered fitment extraction, title rephrasing, and usage stats' },
        { name: 'Affiliate Orders', description: 'Amazon sourcing queue, gift-card balances, spend tracking, and daily summary' },
        { name: 'Micro Orders', description: 'Paginated orders with subtotal < $3 and computed INR profit metrics' },
        { name: 'Payment Accounts', description: 'Payment accounts linked to a bank account' },
        { name: 'Payoneer', description: 'Payoneer receipt records with auto-synced Transaction entries' },
        { name: 'Price Change Logs', description: 'Audit log of eBay price change attempts' },
        { name: 'Exchange Rates', description: 'Marketplace exchange rates with optional order back-fill' },
        { name: 'Template Overrides', description: 'Per-seller overrides on top of a base listing template' },
        { name: 'Best Offers', description: 'eBay Trading API best offers and seller-initiated negotiation offers' },
        { name: 'Amazon Accounts', description: 'Amazon fulfillment account profiles' },
        { name: 'ASIN Directory', description: 'Searchable catalogue of Amazon ASINs with auto-enrichment' },
        { name: 'ASIN List Categories', description: 'Top-level categories for the ASIN product list organiser' },
        { name: 'ASIN List Ranges', description: 'Ranges (sub-groups) within ASIN list categories' },
        { name: 'ASIN List Products', description: 'Products within an ASIN list range' },
        { name: 'Listing Templates', description: 'eBay listing templates with custom columns, automation, and pricing config' },
        { name: 'eBay SKU Index', description: 'Local SKU index synced from eBay for fast active-listing lookups' },
        { name: 'eBay Feed', description: 'eBay Bulk Data Exchange feed upload, task status, and result download' },
        { name: 'eBay OAuth', description: 'eBay OAuth2 connect and callback flow' },
        { name: 'eBay Orders', description: 'Fetch, sync, and query eBay orders' },
        { name: 'eBay Financials', description: 'Ad fees, earnings, and order-total calculations for eBay orders' },
        { name: 'eBay Returns', description: 'Return requests and INR (Item Not Received) cases from eBay Post-Order API' },
        { name: 'eBay – Buyer Messages', description: 'Buyer messages/inquiries fetched via eBay Post-Order API' },
        { name: 'eBay Listings', description: 'Active listing sync and management' },
        { name: 'eBay Sellers', description: 'Seller-level eBay account and selling privileges' }
    ],

    // ─── Security ────────────────────────────────────────────────────────────────
    components: {
        securitySchemes: {
            bearerAuth: {
                type: 'http',
                scheme: 'bearer',
                bearerFormat: 'JWT',
                description: 'Pass the JWT token returned by POST /auth/login in the Authorization header.'
            }
        },

        // ─── Reusable Schemas ────────────────────────────────────────────────────
        schemas: {

            // ── Seller ──────────────────────────────────────────────────────────────
            SellerSummary: {
                type: 'object',
                properties: {
                    _id: { type: 'string', example: '665abc123def456789012345' },
                    user: {
                        type: 'object',
                        properties: {
                            username: { type: 'string', example: 'john_seller' },
                            email: { type: 'string', example: 'john@example.com' }
                        }
                    }
                }
            },

            // ── Thread ──────────────────────────────────────────────────────────────
            Thread: {
                type: 'object',
                properties: {
                    orderId: { type: 'string', nullable: true, example: '28-12345-67890' },
                    buyerUsername: { type: 'string', example: 'cool.buyer99' },
                    buyerName: { type: 'string', nullable: true, example: 'Jane Doe' },
                    itemId: { type: 'string', example: '145678901234' },
                    itemTitle: { type: 'string', nullable: true, example: 'Wireless Earbuds Pro' },
                    sellerId: { type: 'string', example: '665abc123def456789012345' },
                    lastMessage: { type: 'string', example: 'Is this still available?' },
                    lastDate: { type: 'string', format: 'date-time' },
                    sender: { type: 'string', enum: ['BUYER', 'SELLER', 'SYSTEM'], nullable: true },
                    unreadCount: { type: 'integer', example: 2 },
                    messageType: { type: 'string', enum: ['ORDER', 'INQUIRY', 'DIRECT'], nullable: true },
                    marketplaceId: { type: 'string', enum: ['EBAY_US', 'EBAY_CA', 'EBAY_AU', 'EBAY_GB', 'EBAY_DE', 'Unknown'], example: 'EBAY_US' }
                }
            },

            // ── Message ─────────────────────────────────────────────────────────────
            Message: {
                type: 'object',
                properties: {
                    _id: { type: 'string' },
                    seller: { type: 'string', description: 'Seller ObjectId' },
                    orderId: { type: 'string', nullable: true },
                    buyerUsername: { type: 'string' },
                    itemId: { type: 'string' },
                    body: { type: 'string', example: 'Thank you for your order!' },
                    sender: { type: 'string', enum: ['BUYER', 'SELLER'] },
                    messageType: { type: 'string', enum: ['ORDER', 'INQUIRY', 'DIRECT'] },
                    read: { type: 'boolean' },
                    messageDate: { type: 'string', format: 'date-time' },
                    mediaUrls: { type: 'array', items: { type: 'string', format: 'uri' } },
                    externalMessageId: { type: 'string', nullable: true }
                }
            },

            // ── ConversationMeta ─────────────────────────────────────────────────────
            ConversationMeta: {
                type: 'object',
                properties: {
                    _id: { type: 'string' },
                    seller: { type: 'string' },
                    buyerUsername: { type: 'string' },
                    orderId: { type: 'string', nullable: true },
                    itemId: { type: 'string' },
                    category: {
                        type: 'string',
                        nullable: true,
                        enum: ['INR', 'Cancellation', 'Return', 'Refund', 'Replace',
                            'Out of Stock', 'Issue with Product', 'Issue with Delivery', 'Inquiry', ''],
                        description: 'The "About" classification of the conversation'
                    },
                    caseStatus: {
                        type: 'string',
                        enum: ['Case Not Opened', 'Open', 'In Progress', 'Resolved']
                    },
                    status: {
                        type: 'string',
                        enum: ['Case Not Opened', 'Open', 'In Progress', 'Resolved'],
                        description: 'Alias of caseStatus; threads with "Resolved" are hidden from the inbox'
                    },
                    pickedUpBy: {
                        type: 'string',
                        nullable: true,
                        description: 'Name of the chat agent who picked up this conversation'
                    },
                    resolvedAt: { type: 'string', format: 'date-time', nullable: true },
                    resolvedBy: { type: 'string', nullable: true }
                }
            },

            // ── ChatAgent ────────────────────────────────────────────────────────────
            ChatAgent: {
                type: 'object',
                properties: {
                    _id: { type: 'string' },
                    name: { type: 'string', example: 'Sarah' }
                }
            },

            // ── ChatTemplate ─────────────────────────────────────────────────────────
            ChatTemplateDoc: {
                type: 'object',
                properties: {
                    _id: { type: 'string', example: '665abc123def456789012345' },
                    category: { type: 'string', example: 'ORDER / INVENTORY ISSUES' },
                    label: { type: 'string', example: 'Out of Stock' },
                    text: { type: 'string', example: 'Hi, the item is out of stock. We can issue a full refund immediately.' },
                    isActive: { type: 'boolean', example: true },
                    sortOrder: { type: 'integer', example: 0 },
                    createdAt: { type: 'string', format: 'date-time' },
                    updatedAt: { type: 'string', format: 'date-time' }
                }
            },
            TemplateItem: {
                type: 'object',
                properties: {
                    _id: { type: 'string' },
                    label: { type: 'string', example: 'Out of Stock' },
                    text: { type: 'string', example: 'Hi, unfortunately the item is out of stock...' },
                    sortOrder: { type: 'integer' }
                }
            },
            TemplateGroup: {
                type: 'object',
                properties: {
                    category: { type: 'string', example: 'ORDER / INVENTORY ISSUES' },
                    items: { type: 'array', items: { $ref: '#/components/schemas/TemplateItem' } }
                }
            },

            // ── Generic / Error ──────────────────────────────────────────────────────
            Error: {
                type: 'object',
                properties: {
                    error: { type: 'string', example: 'Something went wrong' }
                }
            },

            // ── Template Listing ─────────────────────────────────────────────────────
            TemplateListing: {
                type: 'object',
                properties: {
                    _id: { type: 'string', example: '665abc123def456789012345' },
                    templateId: { type: 'string', example: '665abc123def456789012346' },
                    sellerId: { type: 'string', nullable: true, example: '665abc123def456789012347' },
                    customLabel: { type: 'string', example: 'SKU-00001', description: 'eBay custom label / SKU' },
                    title: { type: 'string', example: 'Bosch Fuel Injector Set 4pcs' },
                    description: { type: 'string', example: 'Fits 2010-2015 Ford Focus 2.0L...' },
                    startPrice: { type: 'number', example: 29.99 },
                    quantity: { type: 'integer', example: 1 },
                    status: { type: 'string', enum: ['draft', 'active', 'inactive', 'sold', 'ended'], example: 'active' },
                    action: { type: 'string', example: 'Add' },
                    categoryId: { type: 'string', example: '33612' },
                    categoryName: { type: 'string', example: '/Auto Parts & Accessories/Car & Truck Parts' },
                    conditionId: { type: 'string', example: '1000-New' },
                    format: { type: 'string', example: 'FixedPrice' },
                    duration: { type: 'string', example: 'GTC' },
                    itemPhotoUrl: { type: 'string', example: 'https://m.media-amazon.com/images/…' },
                    scheduleTime: { type: 'string', nullable: true, example: '2024-06-01T08:00:00.000Z' },
                    downloadBatchId: { type: 'string', nullable: true },
                    downloadBatchNumber: { type: 'integer', nullable: true },
                    downloadedAt: { type: 'string', format: 'date-time', nullable: true },
                    pendingRedownload: { type: 'boolean', example: false },
                    createdBy: { type: 'string', example: '665abc123def456789012348' },
                    createdAt: { type: 'string', format: 'date-time' },
                    updatedAt: { type: 'string', format: 'date-time' }
                }
            },

            // ── Platform ─────────────────────────────────────────────────────────────
            Platform: {
                type: 'object',
                properties: {
                    _id:       { type: 'string', example: '665abc123def456789000001' },
                    name:      { type: 'string', example: 'eBay' },
                    type:      { type: 'string', enum: ['source', 'listing'], example: 'listing' },
                    createdAt: { type: 'string', format: 'date-time' },
                    updatedAt: { type: 'string', format: 'date-time' }
                }
            },

            // ── Store ────────────────────────────────────────────────────────────────
            Store: {
                type: 'object',
                properties: {
                    _id:      { type: 'string', example: '665abc123def456789000002' },
                    name:     { type: 'string', example: 'Grow eBay Store' },
                    platform: { $ref: '#/components/schemas/Platform' },
                    createdAt: { type: 'string', format: 'date-time' },
                    updatedAt: { type: 'string', format: 'date-time' }
                }
            },

            // ── ColumnPreset ─────────────────────────────────────────────────────────
            ColumnPreset: {
                type: 'object',
                properties: {
                    _id:       { type: 'string', example: '665abc123def456789000003' },
                    name:      { type: 'string', example: 'Default View' },
                    page:      { type: 'string', example: 'templateListings' },
                    columns:   { type: 'array', items: { type: 'string' }, example: ['title', 'price', 'quantity'] },
                    createdBy: { type: 'string', example: '665abc123def456789000004' },
                    createdAt: { type: 'string', format: 'date-time' },
                    updatedAt: { type: 'string', format: 'date-time' }
                }
            },

            // ── SellerUploadLimit ────────────────────────────────────────────────
            SellerUploadLimit: {
                type: 'object',
                properties: {
                    _id:          { type: 'string', example: '665abc123def456789000010' },
                    seller:       { type: 'string', description: 'Seller ObjectId' },
                    sellerName:   { type: 'string', example: 'john_seller', description: 'Populated username (list endpoint only)' },
                    country:      { type: 'string', enum: ['US', 'UK', 'AU', 'Canada'], example: 'US' },
                    limit:        { type: 'integer', example: 50, description: 'Daily upload cap' },
                    currentCount: { type: 'integer', example: 12, description: 'Uploads since midnight IST (list endpoint only)' },
                    isBlocked:    { type: 'boolean', example: false, description: 'True when currentCount >= limit' },
                    createdAt:    { type: 'string', format: 'date-time' },
                    updatedAt:    { type: 'string', format: 'date-time' }
                }
            },

            // ── CsvStorageRecord ──────────────────────────────────────────────────
            CsvStorageRecord: {
                type: 'object',
                description: 'CSV record with csvData excluded',
                properties: {
                    _id:                  { type: 'string', example: '665abc123def456789000020' },
                    name:                 { type: 'string', example: 'ebay-export-2024-06-01' },
                    fileName:             { type: 'string', example: 'ebay-export-2024-06-01.csv' },
                    mimeType:             { type: 'string', example: 'text/csv' },
                    seller:               { type: 'object', description: 'Populated seller with storeName and username' },
                    templateId:           { type: 'string', nullable: true },
                    listingCount:         { type: 'integer', example: 120 },
                    categoryName:         { type: 'string', example: 'Phone Cases' },
                    rangeName:            { type: 'string', example: 'iPhone 13-14' },
                    productName:          { type: 'string', example: '' },
                    source:               { type: 'string', nullable: true },
                    country:              { type: 'string', nullable: true, example: 'US' },
                    feedUploadId:         { type: 'object', nullable: true, description: 'Populated FeedUpload (status, taskId)' },
                    scheduledUploadAt:    { type: 'string', format: 'date-time', nullable: true },
                    scheduledSellerId:    { type: 'string', nullable: true },
                    scheduledUploadStatus:{ type: 'string', nullable: true, enum: ['pending', 'processing', 'done', 'failed'] },
                    createdAt:            { type: 'string', format: 'date-time' },
                    updatedAt:            { type: 'string', format: 'date-time' }
                }
            },

            // ── ItemCategoryMap ───────────────────────────────────────────────────
            ItemCategoryMap: {
                type: 'object',
                properties: {
                    _id:        { type: 'string', example: '665abc123def456789000030' },
                    itemNumber: { type: 'string', example: '123456789012' },
                    categoryId: { type: 'object', description: 'Populated category with name' },
                    rangeId:    { type: 'object', nullable: true, description: 'Populated range with name' },
                    productId:  { type: 'object', nullable: true, description: 'Populated product with name' },
                    assignedBy: { type: 'string', description: 'User ID who last set this mapping' },
                    createdAt:  { type: 'string', format: 'date-time' },
                    updatedAt:  { type: 'string', format: 'date-time' }
                }
            },

            // ── UserSellerAssignment ──────────────────────────────────────────────
            UserSellerAssignment: {
                type: 'object',
                properties: {
                    _id:         { type: 'string', example: '665abc123def456789000031' },
                    user:        { type: 'object', description: 'Populated user (username, email, role, department)' },
                    seller:      { type: 'object', description: 'Populated seller with user.username' },
                    dailyTarget: { type: 'integer', example: 50 },
                    createdAt:   { type: 'string', format: 'date-time' },
                    updatedAt:   { type: 'string', format: 'date-time' }
                }
            },

            // ── UserDailyQuantity ─────────────────────────────────────────────────
            UserDailyQuantity: {
                type: 'object',
                properties: {
                    _id:        { type: 'string', example: '665abc123def456789000032' },
                    user:       { type: 'object', description: 'Populated user (username, email, department)' },
                    seller:     { type: 'object', description: 'Populated seller with user.username' },
                    dateString: { type: 'string', example: '2024-06-01' },
                    quantity:   { type: 'integer', example: 48 },
                    dailyTarget:{ type: 'integer', example: 50 },
                    remarks:    { type: 'string', enum: ['Good', 'Average', 'Need for improvement', ''] },
                    createdAt:  { type: 'string', format: 'date-time' },
                    updatedAt:  { type: 'string', format: 'date-time' }
                }
            },

            // ── RemarkTemplate ────────────────────────────────────────────────────
            RemarkTemplate: {
                type: 'object',
                properties: {
                    id:   { type: 'string', example: '665abc123def456789000040' },
                    name: { type: 'string', example: 'Delivered' },
                    text: { type: 'string', example: 'Hello {{buyer_first_name}}, ...' }
                }
            },

            // ── ResolutionOption ──────────────────────────────────────────────────
            ResolutionOption: {
                type: 'object',
                properties: {
                    _id:       { type: 'string', example: '665abc123def456789000041' },
                    name:      { type: 'string', example: 'Replace' },
                    createdAt: { type: 'string', format: 'date-time' },
                    updatedAt: { type: 'string', format: 'date-time' }
                }
            },

            // ── CreditCardName ────────────────────────────────────────────────────
            CreditCardName: {
                type: 'object',
                properties: {
                    _id:       { type: 'string', example: '665abc123def456789000042' },
                    name:      { type: 'string', example: 'Visa ending 4242' },
                    createdAt: { type: 'string', format: 'date-time' },
                    updatedAt: { type: 'string', format: 'date-time' }
                }
            },

            // ── AiFitmentSuggestion ───────────────────────────────────────────────
            AiFitmentSuggestion: {
                type: 'object',
                properties: {
                    make:             { type: 'string', nullable: true, example: 'Toyota' },
                    model:            { type: 'string', nullable: true, example: 'Camry' },
                    startYear:        { type: 'string', nullable: true, example: '2018' },
                    endYear:          { type: 'string', nullable: true, example: '2022' },
                    suggestedTrims:   { type: 'array', items: { type: 'string' } },
                    excludedTrims:    { type: 'array', items: { type: 'string' } },
                    suggestedEngines: { type: 'array', items: { type: 'string' } },
                    excludedEngines:  { type: 'array', items: { type: 'string' } },
                    allFitments:      { type: 'array', items: { type: 'object' } }
                }
            },

            // ── AiFitmentUsageStat ────────────────────────────────────────────────
            AiFitmentUsageStat: {
                type: 'object',
                properties: {
                    userId:               { type: 'string' },
                    username:             { type: 'string' },
                    name:                 { type: 'string' },
                    role:                 { type: 'string' },
                    date:                 { type: 'string', example: '2024-06-01' },
                    aiSuggestCount:       { type: 'integer' },
                    saveNextCount:        { type: 'integer' },
                    saveNextWithDataCount:{ type: 'integer' }
                }
            },

            // ── PaymentAccount ────────────────────────────────────────────────────
            PaymentAccount: {
                type: 'object',
                properties: {
                    _id:         { type: 'string', example: '665abc123def456789000050' },
                    name:        { type: 'string', example: 'Payoneer USD' },
                    bankAccount: { type: 'object', description: 'Populated bank account with name' },
                    createdAt:   { type: 'string', format: 'date-time' },
                    updatedAt:   { type: 'string', format: 'date-time' }
                }
            },

            // ── PayoneerRecord ─────────────────────────────────────────────────────
            PayoneerRecord: {
                type: 'object',
                properties: {
                    _id:                { type: 'string', example: '665abc123def456789000051' },
                    store:              { type: 'object', description: 'Populated store with user.username' },
                    bankAccount:        { type: 'object', description: 'Populated bank account with name' },
                    paymentDate:        { type: 'string', format: 'date-time' },
                    amount:             { type: 'number', example: 500.00 },
                    exchangeRate:       { type: 'number', example: 83.5 },
                    actualExchangeRate: { type: 'number', example: 85.17 },
                    bankDeposit:        { type: 'number', example: 41750.00 },
                    periodStart:        { type: 'string', format: 'date-time', nullable: true },
                    periodEnd:          { type: 'string', format: 'date-time', nullable: true },
                    profit:             { type: 'number', nullable: true },
                    createdAt:          { type: 'string', format: 'date-time' },
                    updatedAt:          { type: 'string', format: 'date-time' }
                }
            },

            // ── PriceChangeLog ────────────────────────────────────────────────────
            PriceChangeLog: {
                type: 'object',
                properties: {
                    _id:          { type: 'string', example: '665abc123def456789000052' },
                    legacyItemId: { type: 'string', example: '123456789012' },
                    orderId:      { type: 'string' },
                    user:         { type: 'object', description: 'Populated user with username and email' },
                    seller:       { type: 'object', description: 'Populated seller with user.username' },
                    oldPrice:     { type: 'number' },
                    newPrice:     { type: 'number' },
                    success:      { type: 'boolean' },
                    errorMessage: { type: 'string', nullable: true },
                    createdAt:    { type: 'string', format: 'date-time' }
                }
            },

            // ── ExchangeRate ────────────────────────────────────────────────────────
            ExchangeRate: {
                type: 'object',
                properties: {
                    _id:             { type: 'string', example: '665abc123def456789000053' },
                    rate:            { type: 'number', example: 83.5 },
                    marketplace:     { type: 'string', example: 'EBAY_US' },
                    effectiveDate:   { type: 'string', format: 'date-time' },
                    applicationMode: { type: 'string', enum: ['effective', 'specific-date'] },
                    notes:           { type: 'string', nullable: true },
                    createdBy:       { type: 'string' },
                    createdAt:       { type: 'string', format: 'date-time' },
                    updatedAt:       { type: 'string', format: 'date-time' }
                }
            },

            // ── TemplateOverride ───────────────────────────────────────────────────
            TemplateOverride: {
                type: 'object',
                properties: {
                    _id:            { type: 'string', example: '665abc123def456789000060' },
                    baseTemplateId: { type: 'string' },
                    sellerId:       { type: 'string' },
                    overrides: {
                        type: 'object',
                        description: 'Flags indicating which sections are overridden',
                        properties: {
                            customColumns:     { type: 'boolean' },
                            asinAutomation:    { type: 'boolean' },
                            pricingConfig:     { type: 'boolean' },
                            coreFieldDefaults: { type: 'boolean' },
                            customActionField: { type: 'boolean' }
                        }
                    },
                    createdAt: { type: 'string', format: 'date-time' },
                    updatedAt: { type: 'string', format: 'date-time' }
                }
            },

            // ── AmazonAccount ──────────────────────────────────────────────────
            AmazonAccount: {
                type: 'object',
                properties: {
                    _id:         { type: 'string', example: '665abc123def456789000061' },
                    name:        { type: 'string', example: 'Amazon US Main' },
                    addressLine1:{ type: 'string' },
                    addressLine2:{ type: 'string' },
                    city:        { type: 'string' },
                    state:       { type: 'string' },
                    postalCode:  { type: 'string' },
                    country:     { type: 'string' },
                    phoneNumber: { type: 'string' },
                    notes:       { type: 'string' },
                    createdAt:   { type: 'string', format: 'date-time' },
                    updatedAt:   { type: 'string', format: 'date-time' }
                }
            },

            // ── AsinDirectoryEntry ────────────────────────────────────────────
            AsinDirectoryEntry: {
                type: 'object',
                properties: {
                    _id:              { type: 'string', example: '665abc123def456789000062' },
                    asin:             { type: 'string', example: 'B08N5WRWNW' },
                    title:            { type: 'string' },
                    brand:            { type: 'string' },
                    price:            { type: 'string', example: '$12.99' },
                    images:           { type: 'array', items: { type: 'string' } },
                    description:      { type: 'string' },
                    region:           { type: 'string', example: 'US' },
                    listProductId:    { type: 'string', nullable: true },
                    scraped:          { type: 'boolean' },
                    scrapedAt:        { type: 'string', format: 'date-time', nullable: true },
                    scrapeError:      { type: 'string', nullable: true },
                    manuallyEdited:   { type: 'boolean' },
                    addedByUserId:    { type: 'string', nullable: true },
                    addedAt:          { type: 'string', format: 'date-time' }
                }
            },

            // ── AsinListCategory ──────────────────────────────────────────────
            AsinListCategory: {
                type: 'object',
                properties: {
                    _id:       { type: 'string', example: '665abc123def456789000063' },
                    name:      { type: 'string', example: 'Electronics' },
                    createdAt: { type: 'string', format: 'date-time' },
                    updatedAt: { type: 'string', format: 'date-time' }
                }
            },

            // ── AsinListRange ──────────────────────────────────────────────────
            AsinListRange: {
                type: 'object',
                properties: {
                    _id:        { type: 'string', example: '665abc123def456789000064' },
                    name:       { type: 'string', example: 'Q4 Range' },
                    categoryId: { type: 'string' },
                    createdAt:  { type: 'string', format: 'date-time' },
                    updatedAt:  { type: 'string', format: 'date-time' }
                }
            },

            // ── AsinListProduct ───────────────────────────────────────────────
            AsinListProduct: {
                type: 'object',
                properties: {
                    _id:        { type: 'string', example: '665abc123def456789000065' },
                    name:       { type: 'string', example: 'USB Chargers' },
                    rangeId:    { type: 'string' },
                    categoryId: { type: 'string' },
                    createdAt:  { type: 'string', format: 'date-time' },
                    updatedAt:  { type: 'string', format: 'date-time' }
                }
            },

            // ── ListingTemplate ───────────────────────────────────────────────
            ListingTemplate: {
                type: 'object',
                properties: {
                    _id:              { type: 'string', example: '665abc123def456789000066' },
                    name:             { type: 'string' },
                    description:      { type: 'string' },
                    category:         { type: 'string' },
                    ebayCategory:     { type: 'string' },
                    customColumns:    { type: 'array', items: { type: 'object' } },
                    asinAutomation:   { type: 'object', properties: { enabled: { type: 'boolean' } } },
                    pricingConfig:    { type: 'object', properties: { enabled: { type: 'boolean' } } },
                    coreFieldDefaults:{ type: 'object' },
                    customActionField:{ type: 'string' },
                    rangeId:          { type: 'string', nullable: true },
                    listProductId:    { type: 'string', nullable: true },
                    createdBy:        { type: 'object', properties: { name: { type: 'string' }, email: { type: 'string' } } },
                    createdAt:        { type: 'string', format: 'date-time' },
                    updatedAt:        { type: 'string', format: 'date-time' }
                }
            },

            // ── EbayOrder ─────────────────────────────────────────────────────
            EbayOrder: {
                type: 'object',
                properties: {
                    _id:                   { type: 'string', example: '665abc123def456789000067' },
                    orderId:               { type: 'string' },
                    legacyOrderId:         { type: 'string' },
                    seller:                { type: 'string' },
                    creationDate:          { type: 'string', format: 'date-time' },
                    lastModifiedDate:      { type: 'string', format: 'date-time' },
                    orderFulfillmentStatus:{ type: 'string' },
                    orderPaymentStatus:    { type: 'string' },
                    productName:           { type: 'string' },
                    itemNumber:            { type: 'string' },
                    quantity:              { type: 'integer' },
                    subtotal:              { type: 'number' },
                    salesTax:              { type: 'number' },
                    shipping:              { type: 'number' },
                    transactionFees:       { type: 'number' },
                    adFee:                 { type: 'number' },
                    adFeeGeneral:          { type: 'number' },
                    orderEarnings:         { type: 'number' },
                    trackingNumber:        { type: 'string', nullable: true },
                    purchaseMarketplaceId: { type: 'string' }
                }
            }
        }
    },

    security: [{ bearerAuth: [] }],

    // ─── Paths ────────────────────────────────────────────────────────────────────
    paths: {

        // ══════════════════════════════════════════════════════════════════════════
        //  SELLERS
        // ══════════════════════════════════════════════════════════════════════════
        '/sellers/all': {
            get: {
                tags: ['Sellers'],
                summary: 'List all sellers',
                description:
                    'Returns every seller document populated with `user.username` and `user.email`. ' +
                    'Used to populate the "Filter by Seller" dropdown in the BuyerChatPage sidebar.\n\n' +
                    '**Roles required:** `fulfillmentadmin`, `superadmin`, `hoc`, `compliancemanager`, ' +
                    '`listingadmin`, `productadmin`, `lister`, `advancelister`, `trainee`, ' +
                    '`compatibilityadmin`, `compatibilityeditor`',
                responses: {
                    200: {
                        description: 'Array of seller objects',
                        content: {
                            'application/json': {
                                schema: {
                                    type: 'array',
                                    items: { $ref: '#/components/schemas/SellerSummary' }
                                }
                            }
                        }
                    },
                    401: { description: 'Unauthorized', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
                    403: { description: 'Forbidden – insufficient role', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }
                }
            }
        },

        // ══════════════════════════════════════════════════════════════════════════
        //  eBay – INBOX
        // ══════════════════════════════════════════════════════════════════════════
        '/ebay/chat/threads': {
            get: {
                tags: ['eBay – Inbox'],
                summary: 'List conversation threads (inbox)',
                description:
                    'Runs a MongoDB aggregation over the `Message` collection to produce **distinct conversation threads**.\n\n' +
                    '**Pipeline summary:**\n' +
                    '1. Optional seller filter\n' +
                    '2. Sort messages newest-first\n' +
                    '3. Group by `(orderId, buyerUsername, itemId)` → last message, unread count\n' +
                    '4. Lookup `orders` for buyer name and marketplace ID\n' +
                    '5. Lookup `listings` for currency → marketplace fallback\n' +
                    '6. Filter by `filterType` (ALL / ORDER / INQUIRY)\n' +
                    '7. Filter by `filterMarketplace` (EBAY_US / EBAY_CA / EBAY_AU)\n' +
                    '8. Filter by `showUnreadOnly`\n' +
                    '9. Lookup `ConversationMeta` – **threads with `status: "Resolved"` are excluded**\n' +
                    '10. Free-text search on orderId, buyerUsername, buyerName, itemId\n' +
                    '11. If search matches an Order with no messages, a **synthetic thread** is injected\n' +
                    '12. Final sort by `lastDate DESC` + pagination\n\n' +
                    '**Auth:** any authenticated user',
                parameters: [
                    { name: 'page', in: 'query', schema: { type: 'integer', default: 1 }, description: 'Page number (1-based)' },
                    { name: 'limit', in: 'query', schema: { type: 'integer', default: 50 }, description: 'Results per page (max practical: 50)' },
                    { name: 'sellerId', in: 'query', schema: { type: 'string' }, description: 'MongoDB ObjectId of a specific seller to filter by' },
                    { name: 'search', in: 'query', schema: { type: 'string' }, description: 'Case-insensitive search against orderId, buyerUsername, buyerName, itemId' },
                    {
                        name: 'filterType', in: 'query',
                        schema: { type: 'string', enum: ['ALL', 'ORDER', 'INQUIRY'], default: 'ALL' },
                        description: '`ORDER` = threads with orderId or messageType ORDER; `INQUIRY` = no orderId and not ORDER type'
                    },
                    {
                        name: 'filterMarketplace', in: 'query',
                        schema: { type: 'string', enum: ['', 'EBAY_US', 'EBAY_CA', 'EBAY_AU', 'EBAY_GB'] },
                        description: 'Restrict to a single marketplace (empty = all)'
                    },
                    {
                        name: 'showUnreadOnly', in: 'query',
                        schema: { type: 'string', enum: ['true', 'false'], default: 'false' },
                        description: 'When "true", only threads with unreadCount > 0 are returned'
                    }
                ],
                responses: {
                    200: {
                        description: 'Paginated list of threads',
                        content: {
                            'application/json': {
                                schema: {
                                    type: 'object',
                                    properties: {
                                        threads: { type: 'array', items: { $ref: '#/components/schemas/Thread' } },
                                        total: { type: 'integer', description: 'Total matching threads before pagination' }
                                    }
                                }
                            }
                        }
                    },
                    401: { description: 'Unauthorized' }
                }
            }
        },

        '/ebay/sync-inbox': {
            post: {
                tags: ['eBay – Inbox'],
                summary: 'Manually sync all seller inboxes ("Check New" button)',
                description:
                    'Loops over every seller that has eBay OAuth tokens and calls the **eBay Trading API ' +
                    '`GetMemberMessages`** (XML/SOAP) for each.\n\n' +
                    '**Sync window:**\n' +
                    '- First-ever sync → last **12 days**\n' +
                    '- Subsequent syncs → from `lastMessagePolledAt` minus **15 min overlap**\n\n' +
                    'New messages are upserted into the `Message` collection and `seller.lastMessagePolledAt` ' +
                    'is updated.\n\n' +
                    '**Roles required:** `fulfillmentadmin`, `superadmin`, `hoc`, `compliancemanager`',
                requestBody: { required: false, description: 'No body required' },
                responses: {
                    200: {
                        description: 'Per-seller sync results',
                        content: {
                            'application/json': {
                                schema: {
                                    type: 'object',
                                    properties: {
                                        success: { type: 'boolean' },
                                        totalNew: { type: 'integer', description: 'Total new messages found across all sellers' },
                                        syncResults: {
                                            type: 'array',
                                            items: {
                                                type: 'object',
                                                properties: {
                                                    sellerName: { type: 'string' },
                                                    newMessages: { type: 'integer' },
                                                    error: { type: 'string', nullable: true }
                                                }
                                            }
                                        }
                                    }
                                },
                                example: { success: true, totalNew: 5, syncResults: [{ sellerName: 'john_seller', newMessages: 5, error: null }] }
                            }
                        }
                    },
                    401: { description: 'Unauthorized' },
                    403: { description: 'Forbidden – insufficient role' }
                }
            }
        },

        '/ebay/sync-thread': {
            post: {
                tags: ['eBay – Inbox'],
                summary: 'Poll a single open thread for new messages (active polling)',
                description:
                    'Called every **10 seconds** while a thread is open in the chat view. ' +
                    'Calls eBay `GetMemberMessages` scoped to the specific `SenderID` (buyerUsername) ' +
                    'and optionally `ItemID`, with a **2-day** look-back window.\n\n' +
                    'Returns `newMessagesFound: true` when new messages were persisted, ' +
                    'causing the frontend to reload the message list.\n\n' +
                    '**Roles required:** `fulfillmentadmin`, `superadmin`, `hoc`, `compliancemanager`',
                requestBody: {
                    required: true,
                    content: {
                        'application/json': {
                            schema: {
                                type: 'object',
                                required: ['sellerId', 'buyerUsername'],
                                properties: {
                                    sellerId: { type: 'string', description: 'MongoDB ObjectId of the seller' },
                                    buyerUsername: { type: 'string', description: 'eBay username of the buyer' },
                                    itemId: { type: 'string', nullable: true, description: 'eBay item ID to narrow the poll (omit for direct messages)' }
                                }
                            }
                        }
                    }
                },
                responses: {
                    200: {
                        description: 'Poll result',
                        content: {
                            'application/json': {
                                schema: {
                                    type: 'object',
                                    properties: {
                                        success: { type: 'boolean' },
                                        newMessagesFound: { type: 'boolean', description: 'true when at least one new message was stored' }
                                    }
                                }
                            }
                        }
                    },
                    400: { description: 'Missing identifiers (sellerId or buyerUsername)' },
                    401: { description: 'Unauthorized' },
                    404: { description: 'Seller not found' }
                }
            }
        },

        // ══════════════════════════════════════════════════════════════════════════
        //  eBay – MESSAGES
        // ══════════════════════════════════════════════════════════════════════════
        '/ebay/chat/messages': {
            get: {
                tags: ['eBay – Messages'],
                summary: 'Fetch all messages for a thread',
                description:
                    'Returns all stored messages for a conversation, sorted by `messageDate ASC`.\n\n' +
                    '**Read state:** fetching a thread does not change buyer-message read flags. Use `/ebay/chat/mark-read` or `/ebay/chat/mark-unread` for explicit status changes.\n\n' +
                    '**Query strategy:** prefer `orderId` when available; fall back to `buyerUsername + itemId`.\n\n' +
                    '**Auth:** any authenticated user',
                parameters: [
                    { name: 'orderId', in: 'query', schema: { type: 'string' }, description: 'Preferred identifier – use for order-based threads' },
                    { name: 'buyerUsername', in: 'query', schema: { type: 'string' }, description: 'Required when orderId is absent' },
                    { name: 'itemId', in: 'query', schema: { type: 'string' }, description: 'Required when orderId is absent' }
                ],
                responses: {
                    200: {
                        description: 'Chronologically ordered list of messages',
                        content: {
                            'application/json': {
                                schema: { type: 'array', items: { $ref: '#/components/schemas/Message' } }
                            }
                        }
                    },
                    400: { description: 'Neither orderId nor (buyerUsername + itemId) were supplied' },
                    401: { description: 'Unauthorized' }
                }
            }
        },

        '/ebay/send-message': {
            post: {
                tags: ['eBay – Messages'],
                summary: 'Send a reply to a buyer via eBay Trading API',
                description:
                    'Sends a message to a buyer through the eBay Trading API then stores the sent message ' +
                    'in the `Message` collection.\n\n' +
                    '**Routing logic:**\n' +
                    '- `orderId` provided → looks up the `Order`, uses **AddMemberMessageRTQ** (transaction reply)\n' +
                    '- Inquiry → finds the previous buyer message to obtain eBay\'s `parentMessageId`, uses **AddMemberMessageAAQtoSeller**\n' +
                    '- `itemId === "DIRECT_MESSAGE"` → **rejected** (eBay does not allow API replies to account-level direct messages)\n\n' +
                    '**Image handling:** attached images are first re-uploaded to eBay\'s picture service; ' +
                    'the resulting eBay URLs are appended as plain text links in the message body ' +
                    '(eBay\'s API does not support `MessageMedia` for outgoing messages).\n\n' +
                    '**Roles required:** `fulfillmentadmin`, `superadmin`, `hoc`, `compliancemanager`',
                requestBody: {
                    required: true,
                    content: {
                        'application/json': {
                            schema: {
                                type: 'object',
                                required: ['buyerUsername', 'body'],
                                properties: {
                                    orderId: { type: 'string', nullable: true, description: 'eBay order ID (use for order threads)' },
                                    itemId: { type: 'string', description: 'eBay item ID ("DIRECT_MESSAGE" will be rejected)' },
                                    buyerUsername: { type: 'string' },
                                    body: { type: 'string', description: 'Plain-text message body (HTML entities will be escaped)' },
                                    subject: { type: 'string', nullable: true },
                                    mediaUrls: {
                                        type: 'array',
                                        items: { type: 'string', format: 'uri' },
                                        description: 'Local upload URLs returned by POST /upload. They will be uploaded to eBay before sending.'
                                    }
                                }
                            }
                        }
                    }
                },
                responses: {
                    200: {
                        description: 'Message sent and saved',
                        content: {
                            'application/json': {
                                schema: {
                                    type: 'object',
                                    properties: {
                                        success: { type: 'boolean' },
                                        message: { $ref: '#/components/schemas/Message' }
                                    }
                                }
                            }
                        }
                    },
                    400: {
                        description: 'Cannot send (direct message, missing itemId, or missing parentMessageId for inquiry)',
                        content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } }
                    },
                    401: { description: 'Unauthorized' },
                    404: { description: 'Order not found' }
                }
            }
        },

        '/ebay/chat/mark-unread': {
            post: {
                tags: ['eBay – Messages'],
                summary: 'Mark a conversation as unread',
                description:
                    'Sets `read: false` on **all buyer-side messages** in the thread. ' +
                    'The thread will reappear with its unread badge in the inbox.\n\n' +
                    '**Auth:** any authenticated user',
                requestBody: {
                    required: true,
                    content: {
                        'application/json': {
                            schema: {
                                type: 'object',
                                properties: {
                                    orderId: { type: 'string', nullable: true },
                                    buyerUsername: { type: 'string' },
                                    itemId: { type: 'string' }
                                }
                            }
                        }
                    }
                },
                responses: {
                    200: {
                        description: 'Messages marked unread',
                        content: {
                            'application/json': {
                                schema: {
                                    type: 'object',
                                    properties: {
                                        success: { type: 'boolean' },
                                        modifiedCount: { type: 'integer' }
                                    }
                                }
                            }
                        }
                    },
                    400: { description: 'Missing query identifiers' },
                    401: { description: 'Unauthorized' }
                }
            }
        },

        // ══════════════════════════════════════════════════════════════════════════
        //  eBay – CONVERSATION META
        // ══════════════════════════════════════════════════════════════════════════
        '/ebay/conversation-meta/single': {
            get: {
                tags: ['eBay – Conversation Meta'],
                summary: 'Get saved tags for a thread',
                description:
                    'Fetches the `ConversationMeta` document for the given thread identity. ' +
                    'Returns `{}` (empty object) if no tags have been saved yet.\n\n' +
                    '**Lookup priority:** `seller + orderId` → else `seller + buyerUsername + itemId` (with `orderId: null`)\n\n' +
                    '**Auth:** any authenticated user',
                parameters: [
                    { name: 'sellerId', in: 'query', required: true, schema: { type: 'string' } },
                    { name: 'buyerUsername', in: 'query', required: true, schema: { type: 'string' } },
                    { name: 'orderId', in: 'query', required: false, schema: { type: 'string' }, description: 'Omit for inquiry threads' },
                    { name: 'itemId', in: 'query', required: false, schema: { type: 'string' } }
                ],
                responses: {
                    200: {
                        description: 'ConversationMeta object, or `{}` if none exists',
                        content: {
                            'application/json': {
                                schema: { $ref: '#/components/schemas/ConversationMeta' }
                            }
                        }
                    },
                    401: { description: 'Unauthorized' }
                }
            }
        },

        '/ebay/conversation-meta': {
            post: {
                tags: ['eBay – Conversation Meta'],
                summary: 'Save (upsert) tags for a thread',
                description:
                    'Creates or updates the `ConversationMeta` record for the thread. ' +
                    'The save button in the chat header calls this endpoint.\n\n' +
                    '> **Important:** setting `caseStatus` to `"Resolved"` causes the thread to be ' +
                    '**filtered out of the inbox** (hidden from all agents).\n\n' +
                    '**Auth:** any authenticated user',
                requestBody: {
                    required: true,
                    content: {
                        'application/json': {
                            schema: {
                                type: 'object',
                                required: ['sellerId', 'caseStatus'],
                                properties: {
                                    sellerId: { type: 'string' },
                                    buyerUsername: { type: 'string' },
                                    orderId: { type: 'string', nullable: true },
                                    itemId: { type: 'string' },
                                    category: {
                                        type: 'string',
                                        nullable: true,
                                        enum: ['', 'INR', 'Cancellation', 'Return', 'Refund', 'Replace',
                                            'Out of Stock', 'Issue with Product', 'Issue with Delivery', 'Inquiry']
                                    },
                                    caseStatus: {
                                        type: 'string',
                                        enum: ['Case Not Opened', 'Open', 'In Progress', 'Resolved'],
                                        description: '**Required.** Setting "Resolved" removes the thread from the inbox.'
                                    },
                                    status: {
                                        type: 'string',
                                        enum: ['Case Not Opened', 'Open', 'In Progress', 'Resolved'],
                                        description: 'Alias of caseStatus; one of the two is used to hide resolved threads.'
                                    },
                                    pickedUpBy: { type: 'string', nullable: true, description: 'Chat agent name from the ChatAgent collection' }
                                }
                            }
                        }
                    }
                },
                responses: {
                    200: {
                        description: 'Upserted meta record',
                        content: {
                            'application/json': {
                                schema: {
                                    type: 'object',
                                    properties: {
                                        success: { type: 'boolean' },
                                        meta: { $ref: '#/components/schemas/ConversationMeta' }
                                    }
                                }
                            }
                        }
                    },
                    400: { description: 'caseStatus is required' },
                    401: { description: 'Unauthorized' }
                }
            }
        },

        // ══════════════════════════════════════════════════════════════════════════
        //  eBay – CHAT AGENTS
        // ══════════════════════════════════════════════════════════════════════════
        '/ebay/chat-agents': {
            get: {
                tags: ['eBay – Chat Agents'],
                summary: 'List all chat agents',
                description:
                    'Returns every `ChatAgent` document sorted alphabetically by name. ' +
                    'Populates the **"Picked Up By"** dropdown in the conversation header.\n\n' +
                    '**Auth:** any authenticated user',
                responses: {
                    200: {
                        description: 'Array of chat agents',
                        content: {
                            'application/json': {
                                schema: { type: 'array', items: { $ref: '#/components/schemas/ChatAgent' } }
                            }
                        }
                    },
                    401: { description: 'Unauthorized' }
                }
            },
            post: {
                tags: ['eBay – Chat Agents'],
                summary: 'Create a new chat agent',
                description: 'Adds a new agent to the "Picked Up By" list.\n\n**Auth:** any authenticated user',
                requestBody: {
                    required: true,
                    content: {
                        'application/json': {
                            schema: {
                                type: 'object',
                                required: ['name'],
                                properties: { name: { type: 'string', example: 'Sarah' } }
                            }
                        }
                    }
                },
                responses: {
                    200: {
                        description: 'Created agent',
                        content: { 'application/json': { schema: { $ref: '#/components/schemas/ChatAgent' } } }
                    },
                    400: { description: 'Name is required' },
                    401: { description: 'Unauthorized' }
                }
            }
        },

        '/ebay/chat-agents/{id}': {
            patch: {
                tags: ['eBay – Chat Agents'],
                summary: 'Rename a chat agent',
                description: '**Auth:** any authenticated user',
                parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
                requestBody: {
                    required: true,
                    content: {
                        'application/json': {
                            schema: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } }
                        }
                    }
                },
                responses: {
                    200: { description: 'Updated agent', content: { 'application/json': { schema: { $ref: '#/components/schemas/ChatAgent' } } } },
                    400: { description: 'Name is required' },
                    401: { description: 'Unauthorized' },
                    404: { description: 'Agent not found' }
                }
            }
        },

        // ══════════════════════════════════════════════════════════════════════════
        //  eBay – ITEM IMAGES
        // ══════════════════════════════════════════════════════════════════════════
        '/ebay/item-images/{itemId}': {
            get: {
                tags: ['eBay – Item Images'],
                summary: 'Get product image(s) for an eBay item',
                description:
                    'Fetches item images from the **eBay Trading API `GetItem`** (XML/SOAP).\n\n' +
                    '**Caching:** results are stored in an in-memory `node-cache` keyed by ' +
                    '`{itemId}_{sellerId}_{thumbnail|full}`. Cache is checked before every API call.\n\n' +
                    'Response header `X-Cache: HIT` is set on cache hits.\n\n' +
                    '**Auth:** any authenticated user',
                parameters: [
                    { name: 'itemId', in: 'path', required: true, schema: { type: 'string' }, description: 'eBay legacy item ID' },
                    { name: 'sellerId', in: 'query', required: true, schema: { type: 'string' }, description: 'MongoDB ObjectId of the seller (needed to select the correct eBay token)' },
                    {
                        name: 'thumbnail', in: 'query', required: false,
                        schema: { type: 'boolean' },
                        description: 'When true, returns only the primary thumbnail URL instead of the full image list'
                    }
                ],
                responses: {
                    200: {
                        description: 'Image URL or list of image URLs',
                        headers: {
                            'X-Cache': { schema: { type: 'string', enum: ['HIT', 'MISS'] } },
                            'Cache-Control': { schema: { type: 'string' } }
                        },
                        content: {
                            'application/json': {
                                schema: {
                                    oneOf: [
                                        { type: 'string', description: 'Thumbnail URL (when thumbnail=true)', example: 'https://i.ebayimg.com/images/g/abc/s-l140.jpg' },
                                        { type: 'array', items: { type: 'string', format: 'uri' }, description: 'Full image URL list' }
                                    ]
                                }
                            }
                        }
                    },
                    400: { description: 'sellerId is required' },
                    401: { description: 'Unauthorized' },
                    404: { description: 'Seller not found' }
                }
            }
        },

        // ══════════════════════════════════════════════════════════════════════════
        //  CHAT TEMPLATES
        // ══════════════════════════════════════════════════════════════════════════
        '/chat-templates': {
            get: {
                tags: ['Chat Templates'],
                summary: 'Get active templates grouped by category',
                description:
                    'Returns all `ChatTemplate` documents where `isActive: true`, sorted by ' +
                    '`category → sortOrder → createdAt`, and grouped into `[{ category, items }]` ' +
                    'for direct rendering in the Templates dropdown menu.\n\n' +
                    '**Auth:** any authenticated user',
                responses: {
                    200: {
                        description: 'Templates grouped by category',
                        content: {
                            'application/json': {
                                schema: {
                                    type: 'object',
                                    properties: {
                                        templates: { type: 'array', items: { $ref: '#/components/schemas/TemplateGroup' } }
                                    }
                                }
                            }
                        }
                    },
                    401: { description: 'Unauthorized' }
                }
            },
            post: {
                tags: ['Chat Templates'],
                summary: 'Create a new template',
                description: '**Roles required:** `fulfillmentadmin`, `superadmin`, `hoc`',
                requestBody: {
                    required: true,
                    content: {
                        'application/json': {
                            schema: {
                                type: 'object',
                                required: ['category', 'label', 'text'],
                                properties: {
                                    category: { type: 'string', example: 'REFUND HANDLING' },
                                    label: { type: 'string', example: 'Full Refund Offered' },
                                    text: { type: 'string', example: 'Hi, we can issue a full refund immediately...' }
                                }
                            }
                        }
                    }
                },
                responses: {
                    201: {
                        description: 'Template created',
                        content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' }, template: { $ref: '#/components/schemas/TemplateItem' } } } } }
                    },
                    400: { description: 'category, label, and text are all required' },
                    401: { description: 'Unauthorized' },
                    403: { description: 'Forbidden – insufficient role' }
                }
            }
        },

        '/chat-templates/all': {
            get: {
                tags: ['Chat Templates'],
                summary: 'Get all templates including inactive (management view)',
                description: 'Returns every template regardless of `isActive` status.\n\n**Roles required:** `fulfillmentadmin`, `superadmin`, `hoc`',
                responses: {
                    200: {
                        description: 'Full template list',
                        content: { 'application/json': { schema: { type: 'object', properties: { templates: { type: 'array', items: { $ref: '#/components/schemas/TemplateItem' } } } } } }
                    },
                    401: { description: 'Unauthorized' },
                    403: { description: 'Forbidden' }
                }
            }
        },

        '/chat-templates/{id}': {
            patch: {
                tags: ['Chat Templates'],
                summary: 'Update a template (label, text, category, isActive, sortOrder)',
                description: '**Roles required:** `fulfillmentadmin`, `superadmin`, `hoc`',
                parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
                requestBody: {
                    required: true,
                    content: {
                        'application/json': {
                            schema: {
                                type: 'object',
                                properties: {
                                    category: { type: 'string' },
                                    label: { type: 'string' },
                                    text: { type: 'string' },
                                    isActive: { type: 'boolean' },
                                    sortOrder: { type: 'integer' }
                                }
                            }
                        }
                    }
                },
                responses: {
                    200: { description: 'Updated template' },
                    401: { description: 'Unauthorized' },
                    403: { description: 'Forbidden' },
                    404: { description: 'Template not found' }
                }
            },
            delete: {
                tags: ['Chat Templates'],
                summary: 'Delete a template',
                description: '**Roles required:** `fulfillmentadmin`, `superadmin`, `hoc`',
                parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
                responses: {
                    200: { description: 'Template deleted' },
                    401: { description: 'Unauthorized' },
                    403: { description: 'Forbidden' },
                    404: { description: 'Template not found' }
                }
            }
        },

        // ══════════════════════════════════════════════════════════════════════════
        //  UPLOAD
        // ══════════════════════════════════════════════════════════════════════════
        '/upload': {
            post: {
                tags: ['Upload'],
                summary: 'Upload image file(s) to attach to a message',
                description:
                    'Accepts up to **5 files** (images only, max **5 MB each**) via `multipart/form-data`.\n\n' +
                    'Files are saved to `public/uploads/` with timestamped filenames using **multer**.\n\n' +
                    'The returned absolute URLs are passed as `mediaUrls` to `POST /ebay/send-message`, ' +
                    'which re-uploads them to eBay\'s picture service before sending.\n\n' +
                    '**Auth:** no auth middleware (upload route is open on the router level)',
                requestBody: {
                    required: true,
                    content: {
                        'multipart/form-data': {
                            schema: {
                                type: 'object',
                                properties: {
                                    files: {
                                        type: 'array',
                                        items: { type: 'string', format: 'binary' },
                                        description: 'Up to 5 image files. Field name must be `files`.'
                                    }
                                }
                            }
                        }
                    }
                },
                responses: {
                    200: {
                        description: 'Absolute URLs for each uploaded file',
                        content: {
                            'application/json': {
                                schema: {
                                    type: 'object',
                                    properties: {
                                        urls: {
                                            type: 'array',
                                            items: { type: 'string', format: 'uri' },
                                            example: ['https://api.example.com/uploads/1709400000000-123456789.jpg']
                                        }
                                    }
                                }
                            }
                        }
                    },
                    400: { description: 'No files uploaded' },
                    500: { description: 'File upload failed' }
                }
            }
        }
    }
};

const options = {
    definition: swaggerDefinition,
    apis: [path.join(__dirname, 'routes/*.js')],
};

export const swaggerSpec = swaggerJsdoc(options);
