require('isomorphic-fetch');
require('mocha');
const {assert} = require('chai');

const rimraf = require("rimraf");
const ecc = require('eosjs-ecc');
const fs = require('fs');
const Embedder = require('./embedder');

// const HOST = 'http://10.0.0.3:8091';
const HOST = 'http://staging.embed.get-scatter.com';
const PROOFS = ['EOS57fs1Mi7RrMChZ9GsxsCYqG22y9PjnmCnakLMALuA8qM3qKcwG'];
const FILES = {
	getDefaultPath: async () => './test_data',
	getFilesForDirectory: async (path) => {
		return fs.readdirSync(path);
	},
	saveFile: async (path, name, data, encoding = 'utf-8') => {
		return new Promise(resolve => {
			try { fs.writeFileSync(`${path}/${name}`, data, encoding); resolve(true); }
			catch(e) { console.error('Error saving file', e); resolve(false); }
		})
	},
	openFile: async (path, encoding = 'utf-8') => {
		return new Promise(resolve => {
			try { fs.readFile(path, encoding, (err, data) => { if(err) return resolve(null); resolve(data); }); }
			catch(e) { console.error('Error opening file', e); resolve(null); }
		})
	},
	existsOrMkdir: async (path) => {
		if(!fs.existsSync(path)) fs.mkdirSync(path, { recursive: true });
		return true;
	},
	exists: async path => {
		return fs.existsSync(path);
	}
};
const NOTIFIER = (title, text) => console.log('Got notification of', title, text);
const PROMPTER = async (title, text) => {
	console.log('Got prompt for', title, text);
	return true;
};
const SIGNATURE_CHECKER = (hashed, signed) => PROOFS[0];
const HASHER = x => ecc.sha256(x);
const PROGRESS_EVENT = (msg) => console.log(msg);

describe('embedder', () => {

	it('should clean up any previous test data', done => {
		new Promise(async () => {
			await new Promise(r => rimraf('./test_data', () => r(true)))
			assert(!await FILES.exists('./test_data'), "Test data was not removed");
			done();
		})
	})

	it('should instantiate properly', done => {
		new Promise(async () => {
			Embedder.init('12.0.0', 'Bridge', PROOFS, FILES, HASHER, NOTIFIER, PROMPTER, SIGNATURE_CHECKER, PROGRESS_EVENT);
			done();
		})
	})


	it('should check if there is a local version [fail test]', done => {
		new Promise(async () => {
			assert(!await Embedder.hasLocalVersion(), 'There was a local version when there should NOT have been.')
			done();
		})
	})

	it('should cache files locally', done => {
		new Promise(async () => {
			assert(await Embedder.check(), 'There was an error caching local files.');
			done();
		})
	});

	it('should check if there is a local version', done => {
		new Promise(async () => {
			assert(await Embedder.hasLocalVersion(), 'There was NOT a local version when there should have been.')
			done();
		})
	})

	it('should not need a new version', done => {
		new Promise(async () => {
			assert(!await Embedder.versionAvailable(), 'Embedder says there is a new version even though there is not.')
			done();
		})
	})

});
