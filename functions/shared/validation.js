/**
 * Project ROZA — Centralized validation schemas with Joi
 * Provides consistent data validation across all Cloud Functions
 */

const Joi = require('joi');
const { HttpsError } = require('firebase-functions/v2/https');

// ===== CORE SCHEMAS =====

/**
 * Product validation schema
 * Used in: suppliers.js, placeOrderV2, manual uploads
 */
const productSchema = Joi.object({
  supplier: Joi.string().required().trim().min(1).max(100),
  brand: Joi.string().required().trim().min(1).max(50),
  id: Joi.string().required().trim().min(1).max(50),
  name: Joi.string().max(500).default(""),
  stock: Joi.number().min(0).default(0),
  price: Joi.number().min(0).default(0)
});

/**
 * Order item validation schema
 * Used in: placeOrderV2
 */
const orderItemSchema = Joi.object({
  docId: Joi.string().optional().trim().max(200),
  supplier: Joi.string().required().trim().min(1).max(100),
  brand: Joi.string().required().trim().min(1).max(50),
  id: Joi.string().required().trim().min(1).max(50),
  qty: Joi.number().min(1).default(1),
  quantity: Joi.number().min(1).optional() // alternative field name
}).custom((value, helpers) => {
  // Normalize qty/quantity fields
  if (value.quantity && !value.qty) {
    value.qty = value.quantity;
  }
  return value;
});

/**
 * Complete order validation schema
 * Used in: placeOrderV2
 */
const orderSchema = Joi.object({
  items: Joi.array().items(orderItemSchema).min(1).required(),
  priceCategory: Joi.string().valid("роздріб", "ціна 1", "ціна 2", "ціна 3", "ціна опт").default("ціна 1"),
  note: Joi.string().max(2000).default(""),
  clientRequestId: Joi.string().max(128).optional(),
  clientName: Joi.string().max(200).optional(),
  clientPhone: Joi.string().max(50).optional(),
  clientEmail: Joi.string().email().max(200).optional()
});

/**
 * Client validation schema
 * Used in: auth.js, admin functions
 */
const clientSchema = Joi.object({
  name: Joi.string().required().trim().min(1).max(200),
  phone: Joi.string().pattern(/^0\d{9}$/).required(),
  email: Joi.string().email().optional(),
  address: Joi.string().max(500).default(""),
  code: Joi.string().max(50).optional()
});

/**
 * Client authentication schema
 * Used in: auth.js
 */
const clientAuthSchema = Joi.object({
  password: Joi.string().required().min(6).max(200),
  phone: Joi.string().pattern(/^0\d{9}$/).optional(),
  clientId: Joi.string().max(128).optional()
}).or('phone', 'clientId');

/**
 * Password change schema
 * Used in: auth.js
 */
const passwordChangeSchema = Joi.object({
  currentPassword: Joi.string().required().min(6).max(200),
  newPassword: Joi.string().required().min(6).max(200),
  confirmPassword: Joi.string().required().valid(Joi.ref('newPassword'))
});

/**
 * Admin password setting schema
 * Used in: auth.js
 */
const adminPasswordSchema = Joi.object({
  clientId: Joi.string().required().trim().min(1).max(128),
  password: Joi.string().required().min(6).max(200)
});

/**
 * Create client schema
 * Used in: createClient
 */
const createClientSchema = Joi.object({
  id: Joi.string().required().trim().min(1).max(128).pattern(/^[a-zA-Z0-9]+$/, { name: 'id' }).messages({
    'string.pattern.base': 'ID клієнта може містити лише літери та цифри.'
  }),
  name: Joi.string().required().trim().min(1).max(200),
  phone: Joi.string().pattern(/^0\d{9}$/, { name: 'phone' }).required().messages({
    'string.pattern.base': 'Телефон має бути у форматі 0XXXXXXXXX (10 цифр, починається з 0).'
  }),
  email: Joi.string().email().optional().allow("", null).max(200),
  address: Joi.string().optional().allow("", null).max(500),
  priceType: Joi.string().valid("роздріб", "ціна 1", "ціна 2", "ціна 3", "ціна опт").default("роздріб"),
  password: Joi.string().min(6).max(200).optional().allow('')
});

/**
 * Update client schema
 * Used in: updateClient
 */
const updateClientSchema = Joi.object({
  clientId: Joi.string().required().trim().min(1).max(128),
  name: Joi.string().trim().min(1).max(200).optional(),
  phone: Joi.string().pattern(/^0\d{9}$/, { name: 'phone' }).optional().messages({
    'string.pattern.base': 'Телефон має бути у форматі 0XXXXXXXXX (10 цифр, починається з 0).'
  }),
  email: Joi.string().email().optional().allow("", null).max(200),
  address: Joi.string().optional().allow("", null).max(500),
  priceType: Joi.string().valid("роздріб", "ціна 1", "ціна 2", "ціна 3", "ціна опт").optional(),
  
  // ОСЬ ТУТ ЗМІНА: додано null у allow
  password: Joi.string().max(200).optional().allow('', null).custom((value, helpers) => {
    // Якщо пароль є (і це рядок), перевіряємо довжину
    if (value && typeof value === 'string' && value.length > 0 && value.length < 6) {
      return helpers.message('Пароль має бути не менше 6 символів або бути порожнім');
    }
    return value;
  })
});
/**
 * Delete client schema
 * Used in: deleteClient
 */
const deleteClientSchema = Joi.object({
  clientId: Joi.string().required().trim().min(1).max(128)
});

/**
 * Document details request schema
 * Used in: getDocDetails
 */
const docDetailsSchema = Joi.object({
  type: Joi.number().required().min(1).max(999),
  docNumber: Joi.string().required().trim().min(1).max(100),
  currency: Joi.string().required().trim().length(3).uppercase()
});

/**
 * Supplier validation schema
 * Used in: suppliers.js
 */
const supplierSchema = Joi.object({
  name: Joi.string().required().trim().min(1).max(200),
  id: Joi.string().optional().trim().max(100),
  priceListUrl: Joi.string().uri().optional(),
  autoUpdate: Joi.boolean().default(false)
});

/**
 * Pricing rules schema
 * Used in: suppliers.js, pricing management
 */
const pricingRulesSchema = Joi.object({
  supplierId: Joi.string().required().trim().max(100),
  retail: Joi.number().min(0).max(1000).default(0),
  p1: Joi.number().min(0).max(1000).default(0),
  p2: Joi.number().min(0).max(1000).default(0),
  p3: Joi.number().min(0).max(1000).default(0),
  wholesale: Joi.number().min(0).max(1000).default(0)
});

/**
 * Registration request schema
 * Used in: submitRegistrationRequest
 */
const registrationRequestSchema = Joi.object({
  phone: Joi.string().pattern(/^0\d{9}$/, { name: 'phone' }).required().messages({
    'string.pattern.base': 'Телефон має бути у форматі 0XXXXXXXXX (10 цифр, починається з 0).'
  }),
  name: Joi.string().trim().min(1).max(200).optional(),
  email: Joi.string().email().optional().allow("").max(200)
});

/**
 * Password reset request schema
 * Used in: submitPasswordResetRequest
 */
const passwordResetRequestSchema = Joi.object({
  phone: Joi.string().pattern(/^0\d{9}$/, { name: 'phone' }).required().messages({
    'string.pattern.base': 'Телефон має бути у форматі 0XXXXXXXXX (10 цифр, починається з 0).'
  })
});

/**
 * Featured product schema
 * Used in: addFeaturedProduct, removeFeaturedProduct
 */
const featuredProductSchema = Joi.object({
  brand: Joi.string().required().trim().min(1).max(50),
  id: Joi.string().required().trim().min(1).max(50)
});

// ===== UTILITY FUNCTIONS =====

/**
 * Validate data against schema with proper error handling
 * @param {Joi.Schema} schema - Joi validation schema
 * @param {Object} data - Data to validate
 * @param {string} context - Context for error messages
 * @returns {Object} Validated and cleaned data
 * @throws {HttpsError} If validation fails
 */
function validateData(schema, data, context = "Data") {
  const { error, value } = schema.validate(data, { 
    abortEarly: false,  // Show all validation errors
    stripUnknown: true, // Remove unknown fields
    allowUnknown: false // Don't allow unknown fields
  });
  
  if (error) {
    const messages = error.details.map(d => d.message).join('; ');
    throw new HttpsError("invalid-argument", `${context} validation failed: ${messages}`);
  }
  
  return value;
}

/**
 * Validate data with custom error messages
 * @param {Joi.Schema} schema - Joi validation schema
 * @param {Object} data - Data to validate
 * @param {string} customErrorMessage - Custom error message
 * @returns {Object} Validated and cleaned data
 */
function validateDataWithMessage(schema, data, customErrorMessage) {
  const { error, value } = schema.validate(data, { 
    abortEarly: false,
    stripUnknown: true,
    allowUnknown: false
  });
  
  if (error) {
    throw new HttpsError("invalid-argument", customErrorMessage);
  }
  
  return value;
}

/**
 * Validate array of items (useful for bulk operations)
 * @param {Joi.Schema} itemSchema - Schema for individual items
 * @param {Array} items - Array of items to validate
 * @param {string} context - Context for error messages
 * @returns {Array} Array of validated items
 */
function validateArray(itemSchema, items, context = "Items") {
  if (!Array.isArray(items)) {
    throw new HttpsError("invalid-argument", `${context} must be an array`);
  }
  
  const validatedItems = [];
  const errors = [];
  
  items.forEach((item, index) => {
    try {
      const validated = validateData(itemSchema, item, `${context}[${index}]`);
      validatedItems.push(validated);
    } catch (error) {
      errors.push(`Item ${index}: ${error.message}`);
    }
  });
  
  if (errors.length > 0) {
    throw new HttpsError("invalid-argument", `Validation errors: ${errors.join('; ')}`);
  }
  
  return validatedItems;
}

// ===== EXPORTS =====

module.exports = {
  // Schemas
  schemas: {
    product: productSchema,
    orderItem: orderItemSchema,
    order: orderSchema,
    client: clientSchema,
    clientAuth: clientAuthSchema,
    passwordChange: passwordChangeSchema,
    adminPassword: adminPasswordSchema,
    createClient: createClientSchema,
    updateClient: updateClientSchema,
    deleteClient: deleteClientSchema,
    docDetails: docDetailsSchema,
    supplier: supplierSchema,
    pricingRules: pricingRulesSchema,
    registrationRequest: registrationRequestSchema,
    passwordResetRequest: passwordResetRequestSchema,
    featuredProduct: featuredProductSchema
  },
  
  // Utility functions
  validateData,
  validateDataWithMessage,
  validateArray
};

