let CLIENT_VERSION, HOST, PROOF_KEYS, NOTIFIER, PROMPTER, FILES, LOCAL_TESTING, SIGNATURE_CHECKER, SHA256, HASH_EVENT;
let ETAGS = {};

const FILE_SERVICE_FNS = ['getFilesForDirectory', 'getDefaultPath', 'saveFile', 'openFile', 'existsOrMkdir', 'exists'];

const cacheETAG = async (filename, tag) => {
	ETAGS[filename] = tag;
	await FILES.existsOrMkdir(await FILES.getDefaultPath());
	await FILES.saveFile(await FILES.getDefaultPath(), 'etags.json', JSON.stringify(ETAGS));
	return true;
}

const getSource = async (filename, method = "GET", tries = 0) => {
	const result = await (async() => Promise.race([
		fetch(`${HOST}/${filename}?rand=${Math.floor(Math.random()*999999)}`, {method, cache:"no-cache"}).then(async x => {
			if(x.status !== 200) return null;
			return {etag:x.headers.get('etag'), file:await x.text()};
		}).catch(err => {
			console.error('source error', filename, err);
			return null;
		}),
		new Promise(r =>
			setTimeout(
				() => r(null),
				5000 * (filename === 'vendor.bundle.js' ? 5 : 1)
			)
		),
	]))();

	if(!result && tries > 3) return null;
	else if (!result && tries <= 3) return getSource(filename, method, tries+1);
	else return result;
};

const ERR_TITLE = 'Scatter Embed Check Failure';
const WEB_APP_ERR = `Your desktop client could not make a connection with our web wallet embed, so it can't verify that it is safe to use. If you are in a country which restricts IPs such as China or Russia, you may need to enable a proxy.`;
const API_ERR = `Scatter failed to make a connection with our API which is used to verify the hash of the web wallet embed. If you are in a country which restricts IPs such as China or Russia, you may need to enable a proxy.`
const HASH_ERR = `The hash created from the web wallet embed does not match the hash returned from our secure API. This could be due to an update happening right now. Please try again in a moment. If this problem persists please contact support immediately at support@get-scatter.com, or on Telegram on the @Scatter channel, or Twitter at @Get_Scatter.`


const saveSource = async (filename, file) => {
	const sourcePath = `${await FILES.getDefaultPath()}/cached_sources`;
	await FILES.existsOrMkdir(sourcePath);
	return FILES.saveFile(sourcePath, filename, file);
};


const checkSignature = async (hashed, signed) => {
	const recovered = await SIGNATURE_CHECKER(hashed, signed);
	let proven = false;
	for(let i = 0; i < PROOF_KEYS.length; i++){
		try {
			if(recovered === PROOF_KEYS[i]) {
				proven = true;
				break;
			}
		} catch(e){}
	}
	return proven;
}

const filterFiles = x => (x.indexOf('js') > -1 || x.indexOf('html') > -1 || x.indexOf('css') > -1) && x.indexOf('etags') === -1;

const hashStat = async (filename, verified, filesLength) => {
	const hashstat = {hash:await SHA256(filename), verified, total:filesLength};
	if(HASH_EVENT) HASH_EVENT(hashstat);
	else console.log('hashstat', hashstat);
};

const alignImportableHosts = (file, revert = false) => {
	if(!revert){

		// Applying absolute URLs to relative static assets.
		// Note: These files won't be available if Embed is down, however they are all purely aesthetic.
		// This saves the user from download another 3+mb of data which will be static anyway.
		file = file.replace(/static\/assets\//g, `${HOST}/static/assets/`);
		file = file.replace(/static\/fonts\/fa-/g, `${HOST}/static/fonts/fa-`);
	} else {
		// We need to revert the static absolute path overwrites for this to verify hashes properly.
		// file = file.replace(/https:\/\/embed.get-scatter.com\/static\/assets\//g, "static/assets/");
		// file = file.replace(/https:\/\/embed.get-scatter.com\/static\/fonts\//g, "static/fonts/");
		file = file.replace(new RegExp(`${HOST.replace(/\//, '\\/')}\/static\/assets\/`, 'g'), "static/assets/");
		file = file.replace(new RegExp(`${HOST.replace(/\//, '\\/')}\/static\/fonts\/fa-`, 'g'), "static/fonts/fa-");
	}

	return file;
};

class Embedder {

	static init(
		clientVersion,
		host,
		proofKeys,
		fileService,
		sha256er,
		notifier = (title, text) => console.log('Notifier: ', title, text),
		prompter = (title, text) => console.log('Prompt: ', title, text),
		signatureChecker = (hashed, signed) => console.log('Signature Checker: ', hashed, signed),
		hashEvent = null,
		localTesting = false
	) {
		CLIENT_VERSION = clientVersion;
		HOST = host;
		PROOF_KEYS = proofKeys;
		FILES = fileService;
		SHA256 = sha256er;
		NOTIFIER = notifier;
		PROMPTER = prompter;
		SIGNATURE_CHECKER = signatureChecker;

		// Optionals
		HASH_EVENT = hashEvent;
		LOCAL_TESTING = localTesting;

		if(!PROOF_KEYS.length) throw new Error('You must include Proofing Keys');
		if(!FILE_SERVICE_FNS.every(prop => typeof FILES[prop] === 'function')) throw new Error(`fileService must have the following methods: ${FILE_SERVICE_FNS}`);
		if(!SHA256 || typeof SHA256 !== 'function') throw new Error('Sha256 must be a function.');
	}

	static async getLocalFiles(){
		return await FILES.getFilesForDirectory(`${await FILES.getDefaultPath()}/cached_sources`)
			.then(files => files.filter(filterFiles))
	}

	// Simply gets a list of files that need verification.
	// If this list is spoofed, Scatter simply won't run as it will be missing files.
	// And in the case of adding files to the list, those files will never be executed
	// as there would be nothing to execute them since normal files are hash verified.
	static async getServerFilesList(){
		if(LOCAL_TESTING){
			// From a local server this pull from a `files.json` file
			return await fetch(`${HOST}/files.json?rand=${Math.floor(Math.random()*99999)}`).then(x => x.json()).catch(() => null);
		} else {
			// From a real server this pulls from directory listing
			return await fetch(`${HOST}/hashes/`).then(x => x.json()).then(x =>
				x.map(y => y.name.replace('.hash', ''))
				// Only showing js/html/css files.
					.filter(filterFiles)
			).catch(() => null);
		}
	}

	// Checks if the user has a timestamp file locally at all,
	// which is always the last file that is cached.
	static async hasLocalVersion(){
		if(LOCAL_TESTING) return true;
		return FILES.openFile(`${await FILES.getDefaultPath()}/cached_sources/embed.timestamp`).then(x => !!x).catch(() => null)
	}

	static async checkServerClientVersionRequirement(){
		const serverClientVersion = await getSource(`min.version`).then(x => x.file).catch(() => null);
		if(!serverClientVersion) return false;
		if(serverClientVersion === CLIENT_VERSION) return true;

		const minVersion = serverClientVersion.split('.').map(x => parseInt(x));
		const currentVersion = CLIENT_VERSION.split('.').map(x => parseInt(x));

		return minVersion.every((x, i) => x <= currentVersion[i]);
	}

	// Checks if a version is available using a timestamp file which matches when the
	// server had it's code updated.
	static async versionAvailable(){
		if(LOCAL_TESTING) return false;

		const localTimestamp = await FILES.openFile(`${await FILES.getDefaultPath()}/cached_sources/embed.timestamp`).catch(() => null);
		if(!localTimestamp) return true;
		const serverTimestamp = await getSource(`hashes/embed.timestamp`).then(x => x.file.trim()).catch(() => null);
		if(!serverTimestamp) return true;
		return localTimestamp.trim() !== serverTimestamp.trim();
	}

	// Hashes and signatures are fetched on a round-robin basis, so each hash+sig for a file is gotten
	// from a different server than the one the file was fetched from.
	static async fileVerified(filename, file){
		if(LOCAL_TESTING) return true;

		const hashsig = await getSource(`hashes/${filename}.hash`).then(x => x.file.trim()).catch(() => null);
		if(!hashsig) return false;

		const [hashed, signed] = hashsig.split('|').map(x => x.trim());
		return (await SHA256(file)) === hashed && await checkSignature(hashed, signed);
	}

	static async checkCachedHashes(){
		if(LOCAL_TESTING) return true;

		let verified = 0;

		const filesList = await Embedder.getServerFilesList();
		if(!filesList) return NOTIFIER(ERR_TITLE, API_ERR);

		await Promise.all(filesList.map(async filename => {

			let file = await FILES.openFile(`${await FILES.getDefaultPath()}/cached_sources/${filename}`).catch(() => null);
			if(!file) return console.log('missing file', filename, file);

			file = alignImportableHosts(file, true);

			if(await this.fileVerified(filename, file)) verified++;
			else console.log('bad verification', filename)

			hashStat(filename, verified, filesList.length);

			return true;
		}));

		return verified === filesList.length;
	}

	// TODO: Remove old files from previous builds which are no longer needed.
	// Otherwise they will conflict with `checkCachedHashes` since files on the server would be missing.
	static async removeDanglingFiles(){

	}

	static async cacheEmbedFiles(cacheFromScratch = false){
		let error = null;
		let verified = 0;

		const versionCheck = await Embedder.checkServerClientVersionRequirement();
		if(!versionCheck) return NOTIFIER(
			`You need to update your client!`,
			`The update you are trying to install requires that you also update your native (desktop/mobile/extension) client.`
		);

		const filesList = await Embedder.getServerFilesList();
		if(!filesList) return NOTIFIER(ERR_TITLE, API_ERR);

		const etagsFile = cacheFromScratch ? null : await FILES.openFile(`${await FILES.getDefaultPath()}/etags.json`).catch(() => null);
		if(etagsFile) ETAGS = JSON.parse(etagsFile);


		const checkFileHash = async (filename) => {
			if(error) return false;

			// Sources are fetched on a round-robin basis, so each file is gotten
			// from a different server, making the attack surface as large as our server count.
			const result = await getSource(filename).catch(() => null);
			if(!result || !result.file.length) return error = WEB_APP_ERR;

			if(await this.fileVerified(filename, result.file)){
				await cacheETAG(filename, result.etag);

				result.file = alignImportableHosts(result.file);

				// Saving the source locally for quicker use and fallback for later hash verification failures.
				// This makes it so the user's local Scatter can never "not work" just because the online Embed is down.
				return await saveSource(filename, result.file);
			} else error = API_ERR;

			return false;
		};

		// If an ETAG already exists on the user's local machine then
		// Scatter won't try to refresh the Embed file.
		// This is completely safe to rely on since even if a malicious server spoofs the ETAG
		// Scatter will simply not download their malicious version of the file as it will
		// use the one locally stored on the user's machine and not the one with the spoofed
		// ETAG.
		const checkEtag = async (filename) => {
			// In testing ETAGs don't exist.
			if(LOCAL_TESTING) return false;

			if(error) return false;
			if(ETAGS.hasOwnProperty(filename) && ETAGS[filename]){
				const result = await getSource(filename, "HEAD").catch(() => null);
				if(!result) return error = WEB_APP_ERR;
				return result.etag === ETAGS[filename];
			}
			return false;
		};

		const checkFile = async filename => {
			if(error) return false;
			if(!cacheFromScratch && await checkEtag(filename) && await FILES.exists(`${await FILES.getDefaultPath()}/cached_sources/${filename}`)) return true;
			else return await checkFileHash(filename);
		};

		await Promise.all(filesList.map(async filename => {
			if(!await checkFile(filename)) return error = HASH_ERR;
			else {
				verified++;
				hashStat(filename, verified, filesList.length);
			}
		}));

		if(error) return NOTIFIER(ERR_TITLE, error);

		if(verified === filesList.length){
			// Lack of a timestamp doesn't mean no validation occurred.
			await getSource(`hashes/embed.timestamp`).then(x => {
				return saveSource('embed.timestamp', x.file.trim()).catch(() => null);
			}).catch(() => null);

			return true;
		}

		return false;
	}

	static async check(){
		let hasEmbed = false;

		const updateLocalFiles = async (cacheFromScratch = false) => {
			if(!await Embedder.cacheEmbedFiles(cacheFromScratch)){
				hasEmbed = await PROMPTER(
					'There was an issue getting the latest Embed version.',
					'Would you like to keep using your locally cached version of Scatter Embed which has already been verified previously?'
				);
			} else hasEmbed = true;
			return true;
		};

		if(await Embedder.versionAvailable()){
			// User doesn't have a local version,
			// so they must grab the version.
			if(!await Embedder.hasLocalVersion()){
				hasEmbed = await Embedder.cacheEmbedFiles();
			}

			// User has a local version, so they can choose to
			// update their local version to the next one.
			else {
				if(await PROMPTER(
					'An updated Scatter Embed is available.',
					'There is an updated version of Scatter Embed available. Do you want to use it?'
				)) await updateLocalFiles();
				else hasEmbed = true;
			}
		} else {
			// Checking if the user's local file hashes match the ones on the server.
			if(await Embedder.checkCachedHashes()) hasEmbed = true;

			// If they don't then we will notify the user and allow them to
			// either continue using their local files, or re-pull the version from
			// the web.
			else {
				if(!await PROMPTER(
					'Some of your local files had mismatched hashes.',
					`It looks like some of the files you have locally don't match the hashes of the current embed version, but your version says it's up to date.
				 Do you want to continue using your local version instead of trying to re-pull the current embed?`
				)) hasEmbed = true;
				else await updateLocalFiles(true);
			}
		}

		return hasEmbed;
	}

}

module.exports = Embedder;
