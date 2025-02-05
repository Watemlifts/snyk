const schema = require('../schema').tables
const _ = require('lodash')
const validator = require('validator')
const Promise = require('bluebird')
const errors = require('../../errors')
const config = require('../../config')
const requireTree = require('../../require-tree').readAll

let validateSchema
let validateSettings
let validateActiveTheme
let validate

let availableThemes

// Provide a few custom validators
//
validator.extend('empty', function empty (str) {
  return _.isEmpty(str)
})

validator.extend('notContains', function notContains (str, badString) {
  return !_.contains(str, badString)
})

validator.extend('isEmptyOrURL', function isEmptyOrURL (str) {
  return (_.isEmpty(str) || validator.isURL(str, { require_protocol: false }))
})

// Validation against schema attributes
// values are checked against the validation objects from schema.js
validateSchema = function validateSchema (tableName, model) {
  const columns = _.keys(schema[tableName])
  let validationErrors = []

  _.each(columns, function each (columnKey) {
    let message = ''

    // check nullable
    if (Object.prototype.hasOwnProperty.call(model, columnKey) && Object.prototype.hasOwnProperty.call(schema[tableName][columnKey], 'nullable') &&
                schema[tableName][columnKey].nullable !== true) {
      if (validator.isNull(model[columnKey]) || validator.empty(model[columnKey])) {
        message = 'Value in [' + tableName + '.' + columnKey + '] cannot be blank.'
        validationErrors.push(new errors.ValidationError(message, tableName + '.' + columnKey))
      }
    }

    // TODO: check if mandatory values should be enforced
    if (model[columnKey] !== null && model[columnKey] !== undefined) {
      // check length
      if (Object.prototype.hasOwnProperty.call(schema[tableName][columnKey], 'maxlength')) {
        if (!validator.isLength(model[columnKey], 0, schema[tableName][columnKey].maxlength)) {
          message = 'Value in [' + tableName + '.' + columnKey + '] exceeds maximum length of ' +
                        schema[tableName][columnKey].maxlength + ' characters.'
          validationErrors.push(new errors.ValidationError(message, tableName + '.' + columnKey))
        }
      }

      // check validations objects
      if (Object.prototype.hasOwnProperty.call(schema[tableName][columnKey], 'validations')) {
        validationErrors = validationErrors.concat(validate(model[columnKey], columnKey, schema[tableName][columnKey].validations))
      }

      // check type
      if (Object.prototype.hasOwnProperty.call(schema[tableName][columnKey], 'type')) {
        if (schema[tableName][columnKey].type === 'integer' && !validator.isInt(model[columnKey])) {
          message = 'Value in [' + tableName + '.' + columnKey + '] is not an integer.'
          validationErrors.push(new errors.ValidationError(message, tableName + '.' + columnKey))
        }
      }
    }
  })

  if (validationErrors.length !== 0) {
    return Promise.reject(validationErrors)
  }

  return Promise.resolve()
}

// Validation for settings
// settings are checked against the validation objects
// form default-settings.json
validateSettings = function validateSettings (defaultSettings, model) {
  const values = model.toJSON()
  let validationErrors = []
  const matchingDefault = defaultSettings[values.key]

  if (matchingDefault && matchingDefault.validations) {
    validationErrors = validationErrors.concat(validate(values.value, values.key, matchingDefault.validations))
  }

  if (validationErrors.length !== 0) {
    return Promise.reject(validationErrors)
  }

  return Promise.resolve()
}

validateActiveTheme = function validateActiveTheme (themeName) {
  // If Ghost is running and its availableThemes collection exists
  // give it priority.
  if (config.paths.availableThemes && Object.keys(config.paths.availableThemes).length > 0) {
    availableThemes = Promise.resolve(config.paths.availableThemes)
  }

  if (!availableThemes) {
    // A Promise that will resolve to an object with a property for each installed theme.
    // This is necessary because certain configuration data is only available while Ghost
    // is running and at times the validations are used when it's not (e.g. tests)
    availableThemes = requireTree(config.paths.themePath)
  }

  return availableThemes.then(function then (themes) {
    if (!Object.prototype.hasOwnProperty.call(themes, themeName)) {
      return Promise.reject(new errors.ValidationError(themeName + ' cannot be activated because it is not currently installed.', 'activeTheme'))
    }
  })
}

// Validate default settings using the validator module.
// Each validation's key is a method name and its value is an array of options
//
// eg:
//      validations: { isURL: true, isLength: [20, 40] }
//
// will validate that a setting's length is a URL between 20 and 40 chars.
//
// If you pass a boolean as the value, it will specify the "good" result. By default
// the "good" result is assumed to be true.
//
// eg:
//      validations: { isNull: false }  // means the "good" result would
//                                      // fail the `isNull` check, so
//                                      // not null.
//
// available validators: https://github.com/chriso/validator.js#validators
validate = function validate (value, key, validations) {
  const validationErrors = []

  _.each(validations, function each (validationOptions, validationName) {
    let goodResult = true

    if (_.isBoolean(validationOptions)) {
      goodResult = validationOptions
      validationOptions = []
    } else if (!_.isArray(validationOptions)) {
      validationOptions = [validationOptions]
    }

    validationOptions.unshift(value)

    // equivalent of validator.isSomething(option1, option2)
    if (validator[validationName].apply(validator, validationOptions) !== goodResult) {
      validationErrors.push(new errors.ValidationError('Validation (' + validationName + ') failed for ' + key, key))
    }

    validationOptions.shift()
  }, this)

  return validationErrors
}

module.exports = {
  validate,
  validator,
  validateSchema,
  validateSettings,
  validateActiveTheme
}
