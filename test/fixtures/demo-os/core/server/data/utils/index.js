const _ = require('lodash')
const Promise = require('bluebird')
const config = require('../../config')
const schema = require('../schema').tables
const clients = require('./clients')

let dbConfig

function addTableColumn (tablename, table, columnname) {
  let column
  const columnSpec = schema[tablename][columnname]

  // creation distinguishes between text with fieldtype, string with maxlength and all others
  if (columnSpec.type === 'text' && Object.prototype.hasOwnProperty.call(columnSpec, 'fieldtype')) {
    column = table[columnSpec.type](columnname, columnSpec.fieldtype)
  } else if (columnSpec.type === 'string' && Object.prototype.hasOwnProperty.call(columnSpec, 'maxlength')) {
    column = table[columnSpec.type](columnname, columnSpec.maxlength)
  } else {
    column = table[columnSpec.type](columnname)
  }

  if (Object.prototype.hasOwnProperty.call(columnSpec, 'nullable') && columnSpec.nullable === true) {
    column.nullable()
  } else {
    column.notNullable()
  }
  if (Object.prototype.hasOwnProperty.call(columnSpec, 'primary') && columnSpec.primary === true) {
    column.primary()
  }
  if (Object.prototype.hasOwnProperty.call(columnSpec, 'unique') && columnSpec.unique) {
    column.unique()
  }
  if (Object.prototype.hasOwnProperty.call(columnSpec, 'unsigned') && columnSpec.unsigned) {
    column.unsigned()
  }
  if (Object.prototype.hasOwnProperty.call(columnSpec, 'references')) {
    // check if table exists?
    column.references(columnSpec.references)
  }
  if (Object.prototype.hasOwnProperty.call(columnSpec, 'defaultTo')) {
    column.defaultTo(columnSpec.defaultTo)
  }
}

function addColumn (table, column) {
  dbConfig = dbConfig || config.database
  return dbConfig.knex.schema.table(table, function (t) {
    addTableColumn(table, t, column)
  })
}

function addUnique (table, column) {
  dbConfig = dbConfig || config.database
  return dbConfig.knex.schema.table(table, function (table) {
    table.unique(column)
  })
}

function dropUnique (table, column) {
  dbConfig = dbConfig || config.database
  return dbConfig.knex.schema.table(table, function (table) {
    table.dropUnique(column)
  })
}

function createTable (table) {
  dbConfig = dbConfig || config.database
  return dbConfig.knex.schema.createTable(table, function (t) {
    const columnKeys = _.keys(schema[table])
    _.each(columnKeys, function (column) {
      return addTableColumn(table, t, column)
    })
  })
}

function deleteTable (table) {
  dbConfig = dbConfig || config.database
  return dbConfig.knex.schema.dropTableIfExists(table)
}

function getTables () {
  dbConfig = dbConfig || config.database
  const client = dbConfig.client

  if (_.contains(_.keys(clients), client)) {
    return clients[client].getTables()
  }

  return Promise.reject('No support for database client ' + client)
}

function getIndexes (table) {
  dbConfig = dbConfig || config.database
  const client = dbConfig.client

  if (_.contains(_.keys(clients), client)) {
    return clients[client].getIndexes(table)
  }

  return Promise.reject('No support for database client ' + client)
}

function getColumns (table) {
  dbConfig = dbConfig || config.database
  const client = dbConfig.client

  if (_.contains(_.keys(clients), client)) {
    return clients[client].getColumns(table)
  }

  return Promise.reject('No support for database client ' + client)
}

function checkTables () {
  dbConfig = dbConfig || config.database
  const client = dbConfig.client

  if (client === 'mysql') {
    return clients[client].checkPostTable()
  }
}

module.exports = {
  checkTables,
  createTable,
  deleteTable,
  getTables,
  getIndexes,
  addUnique,
  dropUnique,
  addColumn,
  getColumns
}
